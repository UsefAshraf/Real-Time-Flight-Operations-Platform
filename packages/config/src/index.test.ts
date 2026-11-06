import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, serviceEnvSchema, z } from './index.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(serviceEnvSchema({ port: 4001 }), {})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 4001,
      SHUTDOWN_TIMEOUT_MS: 10_000,
    });
  });

  it('coerces numeric strings', () => {
    expect(loadConfig(serviceEnvSchema({ port: 4001 }), { PORT: '5000' }).PORT).toBe(5000);
  });

  it('supports service-specific extensions', () => {
    const schema = serviceEnvSchema({ port: 4000 }).extend({ REDIS_URL: z.url() });
    const config = loadConfig(schema, { REDIS_URL: 'redis://localhost:6379' });
    expect(config.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('reports every invalid key in one error', () => {
    const schema = serviceEnvSchema({ port: 4000 }).extend({ REDIS_URL: z.url() });
    const load = () => loadConfig(schema, { PORT: 'abc', LOG_LEVEL: 'loud' });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/PORT[\s\S]*LOG_LEVEL|LOG_LEVEL[\s\S]*PORT/);
    expect(load).toThrow(/REDIS_URL/);
  });
});
