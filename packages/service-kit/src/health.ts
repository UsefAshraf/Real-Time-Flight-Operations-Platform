import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ReadinessCheck {
  /** Dependency name shown in the readiness report, e.g. "postgres". */
  name: string;
  /** Resolve when healthy, throw/reject when not. */
  check: () => Promise<void>;
}

export interface CheckResult {
  name: string;
  status: 'ok' | 'fail';
  durationMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'fail' | 'shutting_down';
  checks: CheckResult[];
}

export interface HealthOptions {
  service: string;
  checks?: ReadinessCheck[];
  /** Per-check timeout so one hung dependency cannot hang the probe. */
  checkTimeoutMs?: number;
}

export const LIVE_PATH = '/health/live';
export const READY_PATH = '/health/ready';

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { name: check.name, status: 'ok', durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      name: check.name,
      status: 'fail',
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Liveness  (`/health/live`):  the process is up and the event loop responds. Never checks
 *   dependencies, so a Redis outage does not make Kubernetes restart every pod.
 * Readiness (`/health/ready`): this instance can serve traffic. Fails while shutting down so
 *   load balancers drain it before the process exits.
 */
export class HealthMonitor {
  private shuttingDown = false;
  private readonly checks: ReadinessCheck[];
  private readonly checkTimeoutMs: number;

  constructor(private readonly options: HealthOptions) {
    this.checks = options.checks ?? [];
    this.checkTimeoutMs = options.checkTimeoutMs ?? 2_000;
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async readiness(): Promise<ReadinessReport> {
    if (this.shuttingDown) {
      return { status: 'shutting_down', checks: [] };
    }
    const checks = await Promise.all(this.checks.map((c) => runCheck(c, this.checkTimeoutMs)));
    return { status: checks.every((c) => c.status === 'ok') ? 'ok' : 'fail', checks };
  }

  /**
   * Request handler that can be mounted in any Node HTTP server.
   * Returns true when it handled the request.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const path = (req.url ?? '/').split('?')[0];

    if (path === LIVE_PATH) {
      sendJson(res, 200, { status: 'ok', service: this.options.service });
      return true;
    }
    if (path === READY_PATH) {
      const report = await this.readiness();
      sendJson(res, report.status === 'ok' ? 200 : 503, {
        service: this.options.service,
        ...report,
      });
      return true;
    }
    return false;
  }
}
