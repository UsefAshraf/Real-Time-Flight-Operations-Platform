import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@flightops/logger';
import { startService, type RunningService, type StartServiceOptions } from './service.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const running: RunningService[] = [];

async function start(overrides: Partial<StartServiceOptions> = {}) {
  const service = await startService({
    name: 'test-service',
    port: 0,
    logger,
    handleSignals: false,
    ...overrides,
  });
  running.push(service);
  return { service, url: (path: string) => `http://127.0.0.1:${service.port}${path}` };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.shutdown('test cleanup')));
});

describe('startService', () => {
  it('serves liveness', async () => {
    const { url } = await start();
    const res = await fetch(url('/health/live'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'test-service' });
  });

  it('reports ready when all checks pass', async () => {
    const { url } = await start({
      readinessChecks: [{ name: 'postgres', check: () => Promise.resolve() }],
    });
    const res = await fetch(url('/health/ready'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      checks: [{ name: 'postgres', status: 'ok' }],
    });
  });

  it('returns 503 with details when a check fails', async () => {
    const { url } = await start({
      readinessChecks: [
        { name: 'postgres', check: () => Promise.resolve() },
        { name: 'redis', check: () => Promise.reject(new Error('ECONNREFUSED')) },
      ],
    });
    const res = await fetch(url('/health/ready'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'fail',
      checks: [
        { name: 'postgres', status: 'ok' },
        { name: 'redis', status: 'fail', error: 'ECONNREFUSED' },
      ],
    });
  });

  it('times out hung checks', async () => {
    const { url } = await start({
      readinessTimeoutMs: 50,
      readinessChecks: [{ name: 'slow', check: () => new Promise(() => undefined) }],
    });
    const res = await fetch(url('/health/ready'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'fail',
      checks: [{ name: 'slow', status: 'fail', error: 'timed out after 50ms' }],
    });
  });

  it('delegates non-health routes to the app handler', async () => {
    const { url } = await start({
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('app');
      },
    });
    expect(await (await fetch(url('/graphql'))).text()).toBe('app');
  });

  it('returns 404 by default for unknown routes', async () => {
    const { url } = await start();
    expect((await fetch(url('/nope'))).status).toBe(404);
  });

  it('fails readiness during drain, then runs shutdown hooks', async () => {
    const calls: string[] = [];
    const { service, url } = await start({
      drainDelayMs: 200,
      onShutdown: [
        () => {
          calls.push('hook');
          return Promise.resolve();
        },
      ],
    });

    const shutdown = service.shutdown('test');
    const res = await fetch(url('/health/ready'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'shutting_down' });

    await shutdown;
    expect(calls).toEqual(['hook']);
    expect(service.server.listening).toBe(false);
  });

  it('is idempotent when shutdown is called twice', async () => {
    const { service } = await start();
    await Promise.all([service.shutdown('a'), service.shutdown('b')]);
    expect(service.server.listening).toBe(false);
  });
});
