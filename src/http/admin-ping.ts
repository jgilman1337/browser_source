/**
 * Authenticated administrative probe endpoint.
 */
import type { Request, Router } from "express";

import { adminPasswordsMatch } from "../platform/auth";

/** Return the bearer token from an Authorization header, if correctly shaped. */
function getBearerToken(request: Request): string | undefined {
	// Read the standard bearer-token authorization header.
	const header = request.get("authorization");
	if (!header?.startsWith("Bearer ")) {
		return undefined;
	}

	// Reject an empty bearer token while preserving the supplied token otherwise.
	const token = header.slice("Bearer ".length);
	return token.length > 0 ? token : undefined;
}

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
