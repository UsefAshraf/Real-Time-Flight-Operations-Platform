import { z } from 'zod';

export { z };

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Keys every process (service or CLI) understands. */
export const commonEnv = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
};

/** Defaults point at the local Docker Compose stack (infra/docker-compose). */
export const databaseEnv = {
  DATABASE_URL: z.string().default('postgres://flightops:flightops@localhost:5433/flightops'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
};

export const redisEnv = {
  REDIS_URL: z.string().default('redis://localhost:6380'),
};

/** Environment shared by every HTTP service. Extend it with service-specific keys. */
export function serviceEnvSchema(defaults: { port: number }) {
  return z.object({
    ...commonEnv,
    PORT: z.coerce.number().int().min(0).max(65_535).default(defaults.port),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  });
}

export type ServiceEnv = z.infer<ReturnType<typeof serviceEnvSchema>>;

/** Parse and validate env vars. Throws one readable error listing every problem. */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
