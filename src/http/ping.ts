/**
 * Public health endpoint.
 */
import type { Router } from "express";

/** Register the unauthenticated health endpoint. */
export function registerPingEndpoint(router: Router): void {
	// Return a small successful response without requiring credentials.
	router.get("/ping", (_request, response) => {
		response.json({ status: "ok" });
	});
}
