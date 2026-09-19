/**
 * Timestamped console helpers.
 *
 * FFmpeg and Puppeteer are noisy; a consistent ISO prefix makes docker logs and
 * local runs easier to correlate when debugging SRT connection issues.
 */
function timestamp(): string {
	return new Date().toISOString();
}

export function log(...args: unknown[]): void {
	console.log(`[${timestamp()}]`, ...args);
}

export function error(...args: unknown[]): void {
	console.error(`[${timestamp()}]`, ...args);
}
