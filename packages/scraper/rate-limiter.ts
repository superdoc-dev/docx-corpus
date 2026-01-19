/**
 * Adaptive token bucket rate limiter for parallel requests.
 * Automatically adjusts RPS based on success/error rates.
 */
export interface RateLimiter {
  acquire(): Promise<void>;
  reportSuccess(): void;
  reportError(status: number): void;
  getCurrentRps(): number;
  getStats(): { successCount: number; errorCount: number };
}

export interface RateLimiterConfig {
  initialRps: number;
  minRps: number;
  maxRps: number;
  backoffFactor?: number; // Multiply RPS by this on error (default: 0.8)
  recoveryFactor?: number; // Multiply RPS by this on success streak (default: 1.05)
  successStreakThreshold?: number; // Successes before recovery (default: 100)
}

export function createRateLimiter(config: RateLimiterConfig | number): RateLimiter {
  // Support legacy single-number signature
  const opts: RateLimiterConfig =
    typeof config === "number" ? { initialRps: config, minRps: 10, maxRps: 200 } : config;

  const {
    initialRps,
    minRps,
    maxRps,
    backoffFactor = 0.8,
    recoveryFactor = 1.05,
    successStreakThreshold = 100,
  } = opts;

  let currentRps = initialRps;
  let tokens = currentRps;
  let lastRefill = Date.now();
  let successStreak = 0;
  let successCount = 0;
  let errorCount = 0;

  function refillTokens() {
    const now = Date.now();
    const elapsed = now - lastRefill;
    tokens = Math.min(currentRps, tokens + (elapsed / 1000) * currentRps);
    lastRefill = now;
  }

  async function acquire(): Promise<void> {
    refillTokens();

    if (tokens >= 1) {
      tokens -= 1;
      return;
    }

    // Wait for next token
    const waitMs = ((1 - tokens) / currentRps) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    tokens = 0;
  }

  function reportSuccess(): void {
    successCount++;
    successStreak++;

    // Gradually increase RPS after sustained success
    if (successStreak >= successStreakThreshold && currentRps < maxRps) {
      currentRps = Math.min(maxRps, currentRps * recoveryFactor);
      successStreak = 0;
    }
  }

  function reportError(status: number): void {
    errorCount++;
    successStreak = 0;

    // Back off on rate limiting errors (503, 429) and IP blocks (403)
    if (status === 503 || status === 429 || status === 403) {
      currentRps = Math.max(minRps, currentRps * backoffFactor);
    }
  }

  function getCurrentRps(): number {
    return Math.round(currentRps);
  }

  function getStats(): { successCount: number; errorCount: number } {
    return { successCount, errorCount };
  }

  return {
    acquire,
    reportSuccess,
    reportError,
    getCurrentRps,
    getStats,
  };
}
