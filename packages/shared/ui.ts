export function header(name: string, version: string) {
  console.log(`\n${name} v${version}\n`);
}

export function section(title: string) {
  console.log(`${title}`);
}

export function keyValue(key: string, value: string | number, indent = 2) {
  const padding = " ".repeat(indent);
  console.log(`${padding}${key.padEnd(10)} ${value}`);
}

export function blank() {
  console.log();
}

export function progressBar(current: number, total: number, width = 20): string {
  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "━".repeat(filled) + "░".repeat(empty);
}

export function clearLines(count: number) {
  for (let i = 0; i < count; i++) {
    process.stdout.write("\x1b[2K"); // Clear current line
    if (i < count - 1) {
      process.stdout.write("\x1b[1A"); // Move up one line
    }
  }
  process.stdout.write("\r"); // Move to start of line
}

export function writeMultiLineProgress(lines: string[], prevLineCount: number) {
  clearLines(prevLineCount);
  process.stdout.write(lines.join("\n"));
  return lines.length;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

export interface ProgressStats {
  saved: number;
  total: number;
  docsPerSec: number;
  currentRps: number;
  skipped: number;
  failed: number;
  retried: number;
  elapsedMs: number;
}

export function formatProgress(stats: ProgressStats): string[] {
  const { saved, total, docsPerSec, currentRps, skipped, failed, retried, elapsedMs } = stats;

  const lines: string[] = [];

  // Line 1: Progress bar with count and percentage
  if (total === Infinity) {
    lines.push(`━━━━━━━━━━━━━━━━━━━━ ${saved} saved`);
  } else {
    const bar = progressBar(saved, total);
    const pct = total > 0 ? ((saved / total) * 100).toFixed(1) : "0.0";
    lines.push(`${bar} ${saved}/${total} (${pct}%)`);
  }

  // Line 2: Metrics
  const metrics: string[] = [];
  metrics.push(`${docsPerSec.toFixed(1)}/s @ ${currentRps} RPS`);
  if (skipped > 0) metrics.push(`${skipped} dup`);
  if (failed > 0) metrics.push(`${failed} fail`);
  if (retried > 0) metrics.push(`${retried} retried`);
  metrics.push(formatDuration(elapsedMs));

  lines.push(metrics.join(" · "));

  return lines;
}

export function logError(message: string) {
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] ${message}`);
}
