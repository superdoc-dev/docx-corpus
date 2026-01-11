/**
 * Bounded async queue with backpressure support.
 * Push blocks when full, pop blocks when empty.
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waitingPushers: (() => void)[] = [];
  private waitingPoppers: ((value: T | null) => void)[] = [];
  private closed = false;

  constructor(private maxSize: number = 1000) {}

  /**
   * Push an item to the queue. Blocks if queue is full.
   * Returns false if queue was closed while waiting.
   */
  async push(item: T): Promise<boolean> {
    while (this.items.length >= this.maxSize && !this.closed) {
      await new Promise<void>((resolve) => this.waitingPushers.push(resolve));
    }
    if (this.closed) return false;
    this.items.push(item);
    this.waitingPoppers.shift()?.(item);
    return true;
  }

  async pop(): Promise<T | null> {
    if (this.items.length > 0) {
      const item = this.items.shift();
      if (item !== undefined) {
        this.waitingPushers.shift()?.();
        return item;
      }
    }
    if (this.closed) return null;
    return new Promise((resolve) => this.waitingPoppers.push(resolve));
  }

  isClosed(): boolean {
    return this.closed;
  }

  close() {
    this.closed = true;
    // Unblock all waiting poppers
    for (const resolve of this.waitingPoppers) {
      resolve(null);
    }
    this.waitingPoppers = [];
    // Unblock all waiting pushers
    for (const resolve of this.waitingPushers) {
      resolve();
    }
    this.waitingPushers = [];
  }
}
