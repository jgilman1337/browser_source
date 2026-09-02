import type { Page } from "puppeteer";

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
export async function enableAutoplayOnPage(page: Page): Promise<void> {
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

		const scan = (root: Element): void => {
			root.querySelectorAll("video,audio").forEach((node) => tryPlay(node as HTMLMediaElement));
		};

		const observe = (root: Node): void => {
			if (root instanceof Element) {
				scan(root);
			}

			new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					mutation.addedNodes.forEach((node) => {
						if (node instanceof HTMLMediaElement) {
							tryPlay(node);
						} else if (node instanceof Element) {
							scan(node);
						}
					});
				}
			}).observe(root, { childList: true, subtree: true });
		};

		if (document.documentElement) {
			observe(document.documentElement);
		} else {
			document.addEventListener("DOMContentLoaded", () => {
				if (document.documentElement) {
					observe(document.documentElement);
				}
			});
		}
	});
}

/** Nudge any media elements that were already on the page when navigation finished. */
export async function kickExistingMedia(page: Page): Promise<void> {
	await page.evaluate(() => {
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
