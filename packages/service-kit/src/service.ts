import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@flightops/logger';
import { HealthMonitor, type ReadinessCheck } from './health.js';

export interface StartServiceOptions {
  name: string;
  port: number;
  logger: Logger;
  readinessChecks?: ReadinessCheck[];
  /** Per-check readiness timeout. */
  readinessTimeoutMs?: number;
  /** App handler for everything that is not a health endpoint. Defaults to 404. */
  handler?: RequestListener;
  /** Hard limit for draining connections before forcing exit. */
  shutdownTimeoutMs?: number;
  /** Time readiness reports "shutting_down" before the server stops accepting connections. */
  drainDelayMs?: number;
  /** Cleanup hooks (close DB pools, Redis, ...) run after the HTTP server closes, in order. */
  onShutdown?: (() => Promise<void>)[];
  /** Install SIGTERM/SIGINT handlers. Disable in tests. */
  handleSignals?: boolean;
}

export interface RunningService {
  server: Server;
  health: HealthMonitor;
  port: number;
  shutdown: (reason?: string) => Promise<void>;
}

const notFound: RequestListener = (_req, res) => {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
};

export async function startService(options: StartServiceOptions): Promise<RunningService> {
  const {
    name,
    port,
    logger,
    handler = notFound,
    shutdownTimeoutMs = 10_000,
    drainDelayMs = 0,
    onShutdown = [],
    handleSignals = true,
  } = options;

  const health = new HealthMonitor({
    service: name,
    checks: options.readinessChecks ?? [],
    checkTimeoutMs: options.readinessTimeoutMs ?? 2_000,
  });

  const server = createServer((req, res) => {
    health
      .handle(req, res)
      .then((handled) => {
        if (!handled) handler(req, res);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'request handler failed');
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const boundPort = (server.address() as AddressInfo).port;
  logger.info({ port: boundPort }, `${name} listening`);

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (reason = 'shutdown'): Promise<void> => {
    shutdownPromise ??= (async () => {
      logger.info({ reason }, 'shutting down');
      health.markShuttingDown();

      // Let load balancers observe the failing readiness probe before we stop listening.
      if (drainDelayMs > 0) await new Promise((r) => setTimeout(r, drainDelayMs));

      const forceTimer = setTimeout(() => {
        logger.warn('shutdown timeout reached, closing remaining connections');
        server.closeAllConnections();
      }, shutdownTimeoutMs);
      forceTimer.unref();

      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeIdleConnections();
      });
      clearTimeout(forceTimer);

      for (const hook of onShutdown) {
        try {
          await hook();
        } catch (error) {
          logger.error({ err: error }, 'shutdown hook failed');
        }
      }
      logger.info('shutdown complete');
    })();
    return shutdownPromise;
  };

  if (handleSignals) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        shutdown(signal)
          .then(() => process.exit(0))
          .catch((error: unknown) => {
            logger.fatal({ err: error }, 'shutdown failed');
            process.exit(1);
          });
      });
    }
  }

  return { server, health, port: boundPort, shutdown };
}
