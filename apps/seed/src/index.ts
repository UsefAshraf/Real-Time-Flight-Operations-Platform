import { commonEnv, databaseEnv, loadConfig, z } from '@flightops/config';
import { createPool, migrate } from '@flightops/db';
import { createLogger } from '@flightops/logger';
import { seedDatabase } from './seed.js';

const int = (fallback: number) => z.coerce.number().int().default(fallback);
const config = loadConfig(
  z.object({
    ...commonEnv,
    ...databaseEnv,
    SEED_RANDOM_SEED: int(42),
    /** Service days to generate, starting SEED_START_OFFSET_DAYS from today (UTC). */
    SEED_DAYS: int(3),
    SEED_START_OFFSET_DAYS: int(-1),
    SEED_FLIGHTS_PER_DAY: int(2_000),
    SEED_PASSENGERS: int(50_000),
    SEED_BOOKINGS_MIN: int(20),
    SEED_BOOKINGS_MAX: int(60),
  }),
);
const logger = createLogger({ service: 'seed', level: config.LOG_LEVEL });

if (config.NODE_ENV === 'production') {
  logger.fatal('Refusing to seed fake data when NODE_ENV=production');
  process.exit(1);
}

const pool = createPool({ connectionString: config.DATABASE_URL, max: 2, logger });
const now = new Date();
const start = new Date(now.getTime() + config.SEED_START_OFFSET_DAYS * 86_400_000);

try {
  await migrate(pool);
  const started = performance.now();
  const summary = await seedDatabase(pool, {
    randomSeed: config.SEED_RANDOM_SEED,
    startDate: start.toISOString().slice(0, 10),
    days: config.SEED_DAYS,
    flightsPerDay: config.SEED_FLIGHTS_PER_DAY,
    passengers: config.SEED_PASSENGERS,
    bookingsPerFlight: { min: config.SEED_BOOKINGS_MIN, max: config.SEED_BOOKINGS_MAX },
    now,
    reset: process.argv.includes('--reset'),
  });
  logger.info({ ...summary, durationMs: Math.round(performance.now() - started) }, 'seed complete');
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
