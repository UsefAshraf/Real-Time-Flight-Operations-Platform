import { databaseEnv, loadConfig, serviceEnvSchema, z } from '@flightops/config';
import { checkDatabase, createPool } from '@flightops/db';
import { FlightService, createRng } from '@flightops/flights-core';
import { createLogger } from '@flightops/logger';
import { startService } from '@flightops/service-kit';
import { SimClock } from './clock.js';
import { LeaderLock } from './leader.js';
import { FlightSimulator } from './simulator.js';

const SERVICE = 'simulator';

const rate = (fallback: number) => z.coerce.number().nonnegative().default(fallback);
const config = loadConfig(
  serviceEnvSchema({ port: 4010 }).extend({
    ...databaseEnv,
    SIM_TICK_MS: z.coerce.number().int().min(100).default(1_000),
    /** 1 = real time; 60 = one simulated minute per real second. */
    SIM_SPEED: z.coerce.number().positive().default(1),
    SIM_RANDOM_SEED: z.coerce.number().int().optional(),
    SIM_DELAYS_PER_MIN: rate(0.3),
    SIM_GATE_CHANGES_PER_MIN: rate(0.2),
    SIM_CANCELLATIONS_PER_MIN: rate(0.01),
    SIM_DIVERSIONS_PER_MIN: rate(0.002),
  }),
);

const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  applicationName: SERVICE,
  logger,
});
const clock = new SimClock(config.SIM_SPEED);
const flights = new FlightService(pool, { clock: () => clock.now() });
const simulator = new FlightSimulator({
  pool,
  flights,
  logger,
  rng: createRng(config.SIM_RANDOM_SEED),
  now: () => clock.now(),
  rates: {
    delaysPerMinute: config.SIM_DELAYS_PER_MIN,
    gateChangesPerMinute: config.SIM_GATE_CHANGES_PER_MIN,
    cancellationsPerMinute: config.SIM_CANCELLATIONS_PER_MIN,
    diversionsPerMinute: config.SIM_DIVERSIONS_PER_MIN,
  },
});
const leader = new LeaderLock(pool);

let timer: NodeJS.Timeout | undefined;
let running: Promise<void> | undefined;

async function runTick(): Promise<void> {
  if (!leader.isLeader) {
    if (!(await leader.tryAcquire())) return;
    logger.info('acquired simulator leadership');
    await simulator.loadGates();
  }
  const result = await simulator.tick();
  const total = (Object.values(result) as number[]).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info({ ...result, simTime: clock.now().toISOString() }, 'tick');
}

function schedule(): void {
  timer = setInterval(() => {
    if (running) {
      simulator.recordSkippedTick();
      return;
    }
    running = runTick()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'simulator tick failed');
      })
      .finally(() => {
        running = undefined;
      });
  }, config.SIM_TICK_MS);
}

await startService({
  name: SERVICE,
  port: config.PORT,
  logger,
  shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  readinessChecks: [{ name: 'postgres', check: () => checkDatabase(pool) }],
  handler: (req, res) => {
    if (req.url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ leader: leader.isLeader, speed: clock.speed, ...simulator.getStats() }),
      );
      return;
    }
    res.writeHead(404).end();
  },
  onShutdown: [
    async () => {
      clearInterval(timer);
      await running;
      await leader.release();
    },
    () => pool.end(),
  ],
});

logger.info({ speed: config.SIM_SPEED, tickMs: config.SIM_TICK_MS }, 'simulator started');
schedule();
