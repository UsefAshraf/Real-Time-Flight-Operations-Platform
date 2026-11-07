import { commonEnv, databaseEnv, loadConfig, z } from '@flightops/config';
import { createLogger } from '@flightops/logger';
import { dropAllSchemas, migrate, migrationStatus } from './migrator.js';
import { createPool } from './pool.js';

const config = loadConfig(z.object({ ...commonEnv, ...databaseEnv }));
const logger = createLogger({ service: 'db-cli', level: config.LOG_LEVEL });
const pool = createPool({ connectionString: config.DATABASE_URL, max: 2, logger });
const command = process.argv[2] ?? 'migrate';

try {
  switch (command) {
    case 'migrate': {
      const result = await migrate(pool);
      logger.info(
        { applied: result.applied, previouslyApplied: result.alreadyApplied },
        result.applied.length > 0
          ? `applied ${result.applied.length} migration(s)`
          : 'database is up to date',
      );
      break;
    }
    case 'status': {
      for (const m of await migrationStatus(pool)) {
        logger.info({ migration: m.id, appliedAt: m.appliedAt }, m.applied ? 'applied' : 'PENDING');
      }
      break;
    }
    case 'reset': {
      if (config.NODE_ENV === 'production') {
        throw new Error('Refusing to reset the database when NODE_ENV=production');
      }
      await dropAllSchemas(pool);
      const result = await migrate(pool);
      logger.info({ applied: result.applied }, 'database reset');
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use: migrate | status | reset`);
  }
} catch (error) {
  logger.error({ err: error }, 'db command failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
