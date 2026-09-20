/**
 * Authenticated administrative probe endpoint.
 */
import type { Router } from "express";

import { adminPasswordsMatch } from "@/platform/auth";
import { getBearerToken } from "@/http/utils";

/** Register the authenticated administrative probe endpoint. */
export function registerAdminPingEndpoint(router: Router, password: string): void {
	// Register the administrative route with its startup-resolved password.
	router.get("/admin_ping", (request, response) => {
		// Read and validate the bearer credential before returning the probe response.
		const token = getBearerToken(request);
		if (!token || !adminPasswordsMatch(token, password)) {
			response.status(401).json({ error: "unauthorized" });
			return;
		}

		// Return a small successful administrative response.
		response.json({ status: "ok" });
	});
}
