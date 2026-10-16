export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  allow(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.limit) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}
