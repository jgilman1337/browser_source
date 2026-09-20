/**
 * Minimal authenticated HTTP control server.
 *
 * This intentionally exposes only health/probe endpoints for now. Future
 * administrative commands can be added without changing authentication.
 */
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";

import { error, log } from "@/platform/logger";
import { registerAdminNavigateEndpoint, type NavigateRequest } from "@/http/admin-navigate";
import { registerAdminPingEndpoint } from "@/http/admin-ping";
import { registerAdminReloadEndpoint } from "@/http/admin-reload";
import { registerPingEndpoint } from "@/http/ping";
import { registerUptimeEndpoint } from "@/http/uptime";

/** HTTP control server settings. */
export type ControlServerConfig = {
	host: string;
	port: number;
};

/** Administrative callbacks exposed by the control server. */
export type ControlServerHandlers = {
	reload: () => Promise<void>;
	navigate: (request: NavigateRequest) => Promise<void>;
};

/** Absolute path to the bundled static frontend directory. */
const PUBLIC_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../public");

/** Start the HTTP control server and return its closeable server instance. */
export async function startControlServer(
	config: ControlServerConfig,
	password: string,
	handlers: ControlServerHandlers,
): Promise<Server> {
	// Create the Express application that owns the control endpoint lifecycle.
	const app = express();
	// Avoid exposing the framework implementation in response headers.
	app.disable("x-powered-by");
	// Log completed requests without recording credentials, headers, or bodies.
	app.use((request, response, next) => {
		// Log a compact Nginx-style request line after the response finishes.
		response.once("finish", () => {
			const requestLine = `${request.method} ${request.originalUrl} HTTP/${request.httpVersion}`;
			log(`${request.ip} - - "${requestLine}" ${response.statusCode}`);
		});
		// Continue processing the request through the remaining middleware.
		next();
	});
	// Parse small request bodies so bodyless endpoints can reject unexpected input.
	app.use(express.raw({ type: "*/*", limit: "8kb" }));

	// Compose the endpoint-specific routes on a dedicated router.
	const router = express.Router();
	// Register the unauthenticated health endpoint.
	registerPingEndpoint(router);
	// Register the public process uptime endpoint.
	registerUptimeEndpoint(router);
	// Register the authenticated administrative endpoint.
	registerAdminPingEndpoint(router, password);
	// Register the authenticated page-reload endpoint.
	registerAdminReloadEndpoint(router, password, handlers.reload);
	// Register the authenticated navigate-to-URL endpoint.
	registerAdminNavigateEndpoint(router, password, handlers.navigate);
	// Mount all control endpoints below the frontend-friendly API namespace.
	app.use("/api", router);
	// Serve the small control frontend from the server root.
	app.use(express.static(PUBLIC_DIRECTORY));

	// Return explicit method and path errors for unsupported control requests.
	app.use((request, response) => {
		// Report the supported method when a known endpoint uses the wrong method.
		const allowByPath: Record<string, string> = {
			"/api/ping": "GET",
			"/api/uptime": "GET",
			"/api/admin_ping": "GET",
			"/api/reload": "POST",
			"/api/navigate": "POST",
		};
		const allowed = allowByPath[request.path];
		if (allowed) {
			response.setHeader("allow", allowed);
			response.status(405).json({ error: "method not allowed" });
			return;
		}
		// Return a generic not-found response for unknown paths.
		response.status(404).json({ error: "not found" });
	});

	// Convert parser and route failures into safe JSON responses.
	app.use((requestError: unknown, _request: Request, response: Response, next: NextFunction) => {
		// Keep Express's error-handler signature while intentionally ending the request here.
		void next;
		// Log the underlying failure without returning implementation details to callers.
		error("Control request failed", requestError);
		// Report oversized request bodies with a specific but non-sensitive response.
		if (requestError instanceof Error && "status" in requestError && requestError.status === 413) {
			response.status(413).json({ error: "request body too large" });
			return;
		}
		// Hide all other internal error details from the caller.
		response.status(500).json({ error: "internal server error" });
	});

	// Bind the Express application to the configured control address and port.
	const server = app.listen(config.port, config.host);
	// Log asynchronous listener failures after startup.
	server.on("error", (serverError) => {
		error("Control server error", serverError);
	});
	// Wait until the listener is ready or startup fails.
	await new Promise<void>((resolve, reject) => {
		// Resolve startup once the operating system accepts connections.
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		// Reject startup when the configured address cannot be bound.
		const onError = (serverError: Error): void => {
			server.off("listening", onListening);
			reject(serverError);
		};
		// Observe the first successful listening event.
		server.once("listening", onListening);
		// Observe an error that occurs before startup completes.
		server.once("error", onError);
	});

	// Announce the address callers should use for the control API.
	log(`Control server listening on http://${config.host}:${config.port}`);
	return server;
}

/** Close the HTTP control server, resolving when its listener is released. */
export async function stopControlServer(server: Server | null): Promise<void> {
	// Treat an absent or already-closed server as an idempotent shutdown.
	if (!server?.listening) {
		return;
	}

	// Wait until the operating system releases the listening socket.
	await new Promise<void>((resolve, reject) => {
		// Resolve on clean close and propagate close failures.
		server.close((closeError) => (closeError ? reject(closeError) : resolve()));
	});
}
