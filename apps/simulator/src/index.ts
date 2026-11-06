import { loadConfig, serviceEnvSchema } from '@flightops/config';
import { createLogger } from '@flightops/logger';
import { startService } from '@flightops/service-kit';

// Flight simulator: drives flights through the state machine and emits events.
// Skeleton only: the real implementation lands in Phase 1 of ROADMAP.md.

const SERVICE = 'simulator';

const config = loadConfig(serviceEnvSchema({ port: 4010 }));
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

await startService({
  name: SERVICE,
  port: config.PORT,
  logger,
  shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
});
