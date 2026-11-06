import { loadConfig, serviceEnvSchema } from '@flightops/config';
import { createLogger } from '@flightops/logger';
import { startService } from '@flightops/service-kit';

// Hive Gateway: composes the federated supergraph and serves queries and subscriptions.
// Skeleton only: the real implementation lands in Phase 3 of ROADMAP.md.

const SERVICE = 'gateway';

const config = loadConfig(serviceEnvSchema({ port: 4000 }));
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

await startService({
  name: SERVICE,
  port: config.PORT,
  logger,
  shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
});
