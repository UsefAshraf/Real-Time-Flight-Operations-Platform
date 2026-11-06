import { loadConfig, serviceEnvSchema } from '@flightops/config';
import { createLogger } from '@flightops/logger';
import { startService } from '@flightops/service-kit';

// Passengers subgraph: passengers, bookings, boarding passes.
// Skeleton only: the real implementation lands in Phase 2 of ROADMAP.md.

const SERVICE = 'subgraph-passengers';

const config = loadConfig(serviceEnvSchema({ port: 4003 }));
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

await startService({
  name: SERVICE,
  port: config.PORT,
  logger,
  shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
});
