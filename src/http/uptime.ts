/**
 * Public process uptime endpoint.
 */
import type { Router } from "express";

import { getUptimeSnapshot } from "@/platform/uptime";

/** Register the unauthenticated uptime endpoint. */
export function registerUptimeEndpoint(router: Router): void {
	// Return process start time and elapsed uptime in seconds and pretty form.
	router.get("/uptime", (_request, response) => {
		response.json(getUptimeSnapshot());
	});
}
