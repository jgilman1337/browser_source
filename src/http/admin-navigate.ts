/**
 * Authenticated navigate-to-URL endpoint.
 */
import type { Router } from "express";

import { adminPasswordsMatch } from "@/platform/auth";
import { getBearerToken, parseNewUrl, parseOptionalSelector, readJsonObject } from "@/http/utils";
import { error } from "@/platform/logger";

export type NavigateRequest = {
	newUrl: string;
	clickPlayTarget?: string;
};

type NavigateHandler = (request: NavigateRequest) => Promise<void>;

/** Register the authenticated page-navigation endpoint. */
export function registerAdminNavigateEndpoint(router: Router, password: string, navigate: NavigateHandler): void {
	router.post("/navigate", async (request, response) => {
		const token = getBearerToken(request);
		if (!token || !adminPasswordsMatch(token, password)) {
			response.status(401).json({ error: "unauthorized" });
			return;
		}

		let payload: NavigateRequest;
		try {
			const body = readJsonObject(request);
			payload = {
				newUrl: parseNewUrl(body.newUrl),
				clickPlayTarget: parseOptionalSelector(body.clickPlayTarget, "clickPlayTarget"),
			};
		} catch (parseError) {
			const message =
				parseError instanceof SyntaxError
					? "invalid JSON body"
					: parseError instanceof Error
						? parseError.message
						: "invalid request body";
			response.status(400).json({ error: message });
			return;
		}

		try {
			await navigate(payload);
			response.json({ status: "ok", url: payload.newUrl, clickPlayTarget: payload.clickPlayTarget ?? null });
		} catch (navigateError) {
			error("Page navigation failed", navigateError);
			response.status(503).json({
				error: navigateError instanceof Error ? navigateError.message : String(navigateError),
			});
		}
	});
}
