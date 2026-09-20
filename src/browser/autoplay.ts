import type { NavigationConfig } from "@/config";
import { log } from "@/platform/logger";

type PageWithTimeouts = {
	setDefaultNavigationTimeout(timeout: number): void;
	setDefaultTimeout(timeout: number): void;
};

type PageWithGoto = PageWithTimeouts & {
	goto(url: string, options?: unknown): Promise<unknown>;
};

/** Apply navigation timeout defaults to page.goto and waitForSelector calls. */
export function applyNavigationTimeouts(page: PageWithTimeouts, navigation: NavigationConfig): void {
	page.setDefaultNavigationTimeout(navigation.timeoutMs);
	page.setDefaultTimeout(navigation.timeoutMs);
}

/** Navigate to an HTML page using configured waitUntil and timeout. */
export async function navigateToTarget(page: PageWithGoto, url: string, navigation: NavigationConfig): Promise<void> {
	applyNavigationTimeouts(page, navigation);
	await page.goto(url, { waitUntil: navigation.waitUntil, timeout: navigation.timeoutMs });
}

type PageLike = {
	evaluateOnNewDocument(pageFunction: () => void): Promise<unknown>;
	evaluate(pageFunction: () => void): Promise<unknown>;
};

type PageWithClick = PageLike & {
	waitForSelector(selector: string, options?: { visible?: boolean }): Promise<unknown>;
	click(selector: string): Promise<void>;
};

type PageWithContent = {
	setContent(html: string, options?: unknown): Promise<void>;
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

/** Click a play/start control, retrying until the selector appears or the wait expires. */
export async function clickPlayTarget(page: PageWithClick, selector: string, navigation: NavigationConfig): Promise<void> {
	const retryAfterMs = Math.max(1, Math.round(navigation.clickRetryAfter * 1000));
	const timeoutMs = navigation.clickTimeout * 1000;
	const deadline = Date.now() + timeoutMs;
	const maxRetries = Math.max(1, Math.ceil(timeoutMs / retryAfterMs));
	let attempt = 0;

	while (true) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new Error(`Timed out after ${navigation.clickTimeout}s waiting for selector \`${selector}\``);
		}
		attempt += 1;
		try {
			await page.waitForSelector(selector, { visible: true, timeout: Math.min(retryAfterMs, remainingMs) });
			await page.click(selector);
			return;
		} catch (err) {
			const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
			if (secondsLeft <= 0 || Date.now() >= deadline) {
				throw new Error(`Timed out after ${navigation.clickTimeout}s waiting for selector \`${selector}\``, {
					cause: err,
				});
			}
			log(`Play target ${selector} not ready (retry ${attempt}/${maxRetries}, ${secondsLeft}s left)`);
		}
	}
}

function escapeHtmlAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * Load a direct media stream URL (MP3, AAC, HLS manifest, etc.) in a minimal HTML page.
 * Chromium follows HTTP redirects when fetching the media element's src.
 */
export async function loadMediaStreamTarget(
	page: PageWithContent & PageWithTimeouts,
	url: string,
	kind: "audio" | "video",
	navigation: NavigationConfig,
): Promise<void> {
	const tag = kind;
	const escapedUrl = escapeHtmlAttr(url);
	applyNavigationTimeouts(page, navigation);
	await page.setContent(
		`<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;}</style></head><body><${tag} src="${escapedUrl}" autoplay></${tag}></body></html>`,
		{ waitUntil: navigation.waitUntil, timeout: navigation.timeoutMs },
	);
}

/** Inject CSS before page scripts run to hide horizontal and vertical scrollbars. */
export async function hideScrollbarsOnPage(page: PageLike): Promise<void> {
	await page.evaluateOnNewDocument(() => {
		// Inject CSS to hide horizontal and vertical scrollbars
		const inject = (): void => {
			const style = document.createElement("style");
			style.textContent = `
				* {
					scrollbar-width: none !important;
					-ms-overflow-style: none !important;
				}
				*::-webkit-scrollbar {
					display: none !important;
					width: 0 !important;
					height: 0 !important;
				}
			`;
			(document.head ?? document.documentElement).appendChild(style);
		};

		// If the head element is available, inject the CSS
		if (document.head) {
			inject();
		} else {
			document.addEventListener("DOMContentLoaded", inject, { once: true });
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
