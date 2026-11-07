import { databaseEnv, loadConfig, redisEnv, serviceEnvSchema, z } from '@flightops/config';
import { checkDatabase, createPool } from '@flightops/db';
import { createLogger } from '@flightops/logger';
import { startService } from '@flightops/service-kit';
import { Redis } from 'ioredis';
import { OutboxRelay } from './relay.js';

const SERVICE = 'outbox-relay';

const config = loadConfig(
  serviceEnvSchema({ port: 4011 }).extend({
    ...databaseEnv,
    ...redisEnv,
    OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(200),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    OUTBOX_RETENTION_HOURS: z.coerce.number().int().positive().default(72),
    OUTBOX_STREAM_MAX_LENGTH: z.coerce.number().int().positive().default(100_000),
  }),
);
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  applicationName: SERVICE,
  logger,
});
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on('error', (error) => {
  logger.warn({ err: error }, 'redis connection error');
});

const relay = new OutboxRelay({
  pool,
  redis,
  logger,
  batchSize: config.OUTBOX_BATCH_SIZE,
  pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  retentionHours: config.OUTBOX_RETENTION_HOURS,
  streamMaxLength: config.OUTBOX_STREAM_MAX_LENGTH,
});

await startService({
  name: SERVICE,
  port: config.PORT,
  logger,
  shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  readinessChecks: [
    { name: 'postgres', check: () => checkDatabase(pool) },
    {
      name: 'redis',
      check: async () => {
        await redis.ping();
      },
    },
  ],
  handler: (req, res) => {
    if (req.url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(relay.getStats()));
      return;
    }
    res.writeHead(404).end();
  },
  onShutdown: [
    () => relay.stop(),
    async () => {
      await redis.quit();
    },
    () => pool.end(),
  ],
});

await relay.start();
logger.info('outbox relay started');
