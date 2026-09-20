/** Wall-clock time when this process started (first import of this module). */
const startedAtMs = Date.now();

/** Pad a number to two digits for uptime formatting. */
function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** Format elapsed seconds as `00d 00h 00m 00s`. */
export function formatUptimePretty(totalSeconds: number): string {
	const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(wholeSeconds / 86_400);
	const hours = Math.floor((wholeSeconds % 86_400) / 3_600);
	const minutes = Math.floor((wholeSeconds % 3_600) / 60);
	const seconds = wholeSeconds % 60;
	return `${pad2(days)}d ${pad2(hours)}h ${pad2(minutes)}m ${pad2(seconds)}s`;
}

/** Current process uptime snapshot for API responses. */
export function getUptimeSnapshot(): {
	startTime: string;
	uptimeMs: number;
	uptimePretty: string;
} {
	const uptimeMillis = Date.now() - startedAtMs;
	return {
		startTime: new Date(startedAtMs).toISOString(),
		uptimeMs: uptimeMillis,
		uptimePretty: formatUptimePretty(uptimeMillis / 1000),
	};
}
