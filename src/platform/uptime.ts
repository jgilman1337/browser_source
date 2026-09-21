/** Wall-clock time when this process started (first import of this module). */
const startedAtMs = Date.now();
/** Wall-clock time when the currently captured page became active. */
let pageStartedAtMs: number | null = null;

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

/** Mark the current browser page and capture as active. */
export function markPageStarted(): void {
	pageStartedAtMs = Date.now();
}

/** Current process and browser-page uptime snapshot for API responses. */
export function getUptimeSnapshot(): {
	startTime: string;
	uptimeMs: number;
	uptimePretty: string;
	pageStartTime: string | null;
	pageUptimeMs: number | null;
	pageUptimePretty: string | null;
} {
	const uptimeMillis = Date.now() - startedAtMs;
	const pageUptimeMillis = pageStartedAtMs === null ? null : Math.max(0, Date.now() - pageStartedAtMs);
	return {
		startTime: new Date(startedAtMs).toISOString(),
		uptimeMs: uptimeMillis,
		uptimePretty: formatUptimePretty(uptimeMillis / 1000),
		pageStartTime: pageStartedAtMs === null ? null : new Date(pageStartedAtMs).toISOString(),
		pageUptimeMs: pageUptimeMillis,
		pageUptimePretty: pageUptimeMillis === null ? null : formatUptimePretty(pageUptimeMillis / 1000),
	};
}
