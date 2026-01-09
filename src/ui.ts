import pkg from "../package.json";

export const VERSION = pkg.version;

export function header() {
  console.log(`\ndocx-corpus v${VERSION}\n`);
}

export function section(title: string) {
  console.log(`${title}`);
}

export function keyValue(key: string, value: string | number, indent = 2) {
  const padding = " ".repeat(indent);
  console.log(`${padding}${key.padEnd(10)} ${value}`);
}

export function divider(char = "─", length = 40) {
  console.log(char.repeat(length));
}

export function blank() {
  console.log();
}

export function progressBar(
  current: number,
  total: number,
  width = 20,
): string {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return "━".repeat(filled) + "░".repeat(empty);
}

export function clearLine() {
  process.stdout.write("\r\x1b[K");
}

export function writeProgress(message: string) {
  clearLine();
  process.stdout.write(message);
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
