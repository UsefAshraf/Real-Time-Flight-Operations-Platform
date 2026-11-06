import { z } from 'zod';

export { z };

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Environment shared by every service. Extend it with service-specific keys. */
export function serviceEnvSchema(defaults: { port: number }) {
  return z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
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
