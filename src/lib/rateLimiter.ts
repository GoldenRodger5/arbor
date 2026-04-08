export class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens: number;
  private readonly maxTokens: number;
  private intervalId: ReturnType<typeof setInterval>;

  constructor(requestsPerSecond: number) {
    this.maxTokens = requestsPerSecond;
    this.tokens = requestsPerSecond;
    this.intervalId = setInterval(() => {
      this.tokens = Math.min(
        this.maxTokens,
        this.tokens + requestsPerSecond
      );
      this.processQueue();
    }, 1000);
  }

  async acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.tokens > 0) {
      this.tokens--;
      const next = this.queue.shift();
      next?.();
    }
  }

  destroy(): void {
    clearInterval(this.intervalId);
  }
}
