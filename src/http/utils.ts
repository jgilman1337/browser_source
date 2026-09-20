/**
 * Shared HTTP helpers.
 */
import type { Request } from "express";

/** Return the bearer token from an Authorization header, if correctly shaped. */
export function getBearerToken(request: Request): string | undefined {
	// Read the standard bearer-token authorization header.
	const header = request.get("authorization");
	if (!header?.startsWith("Bearer ")) {
		return undefined;
	}

	// Reject an empty bearer token while preserving the supplied token otherwise.
	const token = header.slice("Bearer ".length);
	return token.length > 0 ? token : undefined;
}

/** Parse a JSON object from the raw request body used by the control server. */
export function readJsonObject(request: Request): Record<string, unknown> {
	const raw = request.body;
	if (!Buffer.isBuffer(raw) || raw.length === 0) {
		return {};
	}
	const parsed: unknown = JSON.parse(raw.toString("utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/** Require an absolute http(s) URL from a JSON field named `newUrl`. */
export function parseNewUrl(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("newUrl is required");
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("newUrl is not a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("newUrl must be an http or https URL");
	}
	return url.href;
}

/** Return a CSS selector from an optional JSON field, or undefined when omitted. */
export function parseOptionalSelector(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string`);
	}
	const selector = value.trim();
	return selector.length > 0 ? selector : undefined;
}
