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
