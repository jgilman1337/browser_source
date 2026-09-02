/** Structural page type so autoplay works with puppeteer-stream's puppeteer-core 24 Page. */
type PageLike = {
	evaluateOnNewDocument(pageFunction: () => void): Promise<unknown>;
	evaluate(pageFunction: () => void): Promise<unknown>;
};

/**
 * Chromium flags that disable autoplay gesture requirements and related media blocks.
 * Always merged into launch args — not optional for this use case.
 */
export const AUTOPLAY_LAUNCH_ARGS = [
	"--autoplay-policy=no-user-gesture-required",
	"--disable-features=PreloadMediaEngagementMetrics,BlockPromptingIfIgnoredOften",
] as const;

/**
 * Injected before any page script runs. Watches for <video>/<audio> elements and
 * calls play() automatically so embedded players do not wait for a user click.
 */
export async function enableAutoplayOnPage(page: PageLike): Promise<void> {
	await page.evaluateOnNewDocument(() => {
		const tryPlay = (element: HTMLMediaElement): void => {
			// Some players start muted to satisfy stricter policies; unmute for capture.
			element.muted = false;
			element.play().catch(() => {
				// Retry muted — better than silence if the site blocks unmuted autoplay.
				element.muted = true;
				element.play().catch(() => {});
			});
		};

		// Scan the root element for video and audio elements and try to play them
		const scan = (root: Element): void => {
			root.querySelectorAll("video,audio").forEach((node) => tryPlay(node as HTMLMediaElement));
		};

		// Observe the root element for video and audio elements and try to play them
		const observe = (root: Node): void => {
			// If the root is an element, scan it for video and audio elements and try to play them
			if (root instanceof Element) {
				scan(root);
			}

			// Watch for new video and audio elements and try to play them
			new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					mutation.addedNodes.forEach((node) => {
						// If the node is a media element, try to play it
						if (node instanceof HTMLMediaElement) {
							tryPlay(node);
						} else if (node instanceof Element) {
							scan(node);
						}
					});
				}
			}).observe(root, { childList: true, subtree: true });
		};

		// If the document element is available, observe it for video and audio elements and try to play them
		if (document.documentElement) {
			observe(document.documentElement);
		} else {
			// If the document element is not available, wait for the DOM to be loaded and observe it for video and audio elements and try to play them
			document.addEventListener("DOMContentLoaded", () => {
				if (document.documentElement) {
					observe(document.documentElement);
				}
			});
		}
	});
}

/** Nudge any media elements that were already on the page when navigation finished. */
export async function kickExistingMedia(page: PageLike): Promise<void> {
	await page.evaluate(() => {
		// Scan the document for video and audio elements and try to play them
		document.querySelectorAll("video,audio").forEach((node) => {
			const element = node as HTMLMediaElement;
			element.muted = false;
			element.play().catch(() => {
				element.muted = true;
				element.play().catch(() => {});
			});
		});
	});
}
