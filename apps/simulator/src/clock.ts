/**
 * Simulation clock. At speed 1 it is the wall clock; at speed 60 one real second advances the
 * simulation by one minute, which makes a whole day of operations watchable in 24 minutes.
 */
export class SimClock {
  private readonly realStart: number;
  private readonly simStart: number;

  constructor(
    readonly speed = 1,
    start: Date = new Date(),
    private readonly realNow: () => number = Date.now,
  ) {
    if (speed <= 0) throw new RangeError('speed must be positive');
    this.realStart = realNow();
    this.simStart = start.getTime();
  }

  now(): Date {
    return new Date(this.simStart + (this.realNow() - this.realStart) * this.speed);
  }
}
