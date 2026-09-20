/**
 * Authenticated page-reload endpoint.
 */
import type { Router } from "express";

import { adminPasswordsMatch } from "@/platform/auth";
import { getBearerToken } from "@/http/utils";
import { error } from "@/platform/logger";

type ReloadHandler = () => Promise<void>;

/** Register the authenticated page-reload endpoint. */
export function registerAdminReloadEndpoint(router: Router, password: string, reload: ReloadHandler): void {
	router.post("/reload", async (request, response) => {
		const token = getBearerToken(request);
		if (!token || !adminPasswordsMatch(token, password)) {
			response.status(401).json({ error: "unauthorized" });
			return;
		}
		try {
			await reload();
			response.json({ status: "ok" });
		} catch (reloadError) {
			error("Page reload failed", reloadError);
			response.status(503).json({
				error: reloadError instanceof Error ? reloadError.message : String(reloadError),
			});
		}
	});
}
