/**
 * Administrative credential loading and comparison.
 *
 * The credential is intentionally resolved once at startup. Changing the file
 * or configuration while the process is running does not rotate access.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "@/platform/fs";

/** Name of the fallback credential file in the process working directory. */
export const ADMIN_PASSWORD_FILE = "admin_password";

/** Result of resolving the administrative credential. */
export type AdminPasswordResolution = {
	password: string;
	source: "config" | "file" | "generated";
};

/** Remove line terminators commonly added when creating a secret file. */
function removeTrailingLineTerminators(value: string): string {
	// Remove only line terminators added by a password-file writer.
	return value.replace(/[\r\n]+$/u, "");
}

/** Generate a high-entropy URL-safe administrative password. */
function generateAdminPassword(): string {
	// Generate 256 bits of cryptographically secure random data.
	return randomBytes(32).toString("base64url");
}

/**
 * Load the configured password, fallback file, or a newly generated password.
 * A generated password is persisted with owner-only permissions.
 */
export async function resolveAdminPassword(configuredPassword?: string): Promise<AdminPasswordResolution> {
	// Prefer an explicitly configured password over filesystem fallbacks.
	if (configuredPassword !== undefined) {
		return { password: configuredPassword, source: "config" };
	}

	try {
		// Read and normalize the existing fallback password file.
		const password = removeTrailingLineTerminators(await readFile(ADMIN_PASSWORD_FILE, "utf8"));
		// Reject an existing but unusable empty password file.
		if (!password) {
			throw new Error(`${ADMIN_PASSWORD_FILE} is empty`);
		}
		// Use the existing password without generating a replacement.
		return { password, source: "file" };
	} catch (error) {
		// Propagate read failures other than a missing password file.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Unable to read ${ADMIN_PASSWORD_FILE}`, { cause: error });
		}
	}

	// Generate a password when no configured or persisted credential exists.
	const password = generateAdminPassword();
	try {
		// Persist the generated password with owner-only permissions.
		await writeFile(ADMIN_PASSWORD_FILE, `${password}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		// Return the credential that this process just created.
		return { password, source: "generated" };
	} catch (error) {
		// Reuse a password created concurrently by another process.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}

		// Read the concurrently-created password file.
		const existingPassword = removeTrailingLineTerminators(await readFile(ADMIN_PASSWORD_FILE, "utf8"));
		// Reject a concurrently-created but unusable empty password file.
		if (!existingPassword) {
			throw new Error(`${ADMIN_PASSWORD_FILE} is empty`, { cause: error });
		}
		// Use the concurrently-created password for this process.
		return { password: existingPassword, source: "file" };
	}
}

/** Compare two credentials in constant time using fixed-length digests. */
export function adminPasswordsMatch(provided: string, expected: string): boolean {
	// Hash both values to fixed-length buffers before timing-safe comparison.
	const providedDigest = createHash("sha256").update(provided).digest();
	const expectedDigest = createHash("sha256").update(expected).digest();
	// Compare the fixed-length digests without an early-exit timing signal.
	return timingSafeEqual(providedDigest, expectedDigest);
}
