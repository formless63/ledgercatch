import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

// A cancelled native RPC upload can reach Vite's error middleware before Start.
// Close that disconnected transport instead of broadcasting a compiler overlay.
// Live requests and every other error still reach Vite's normal error handler.
export function isClientDisconnect(error: unknown, request: Pick<IncomingMessage, "aborted">) {
  return request.aborted && typeof error === "object" && error !== null && "code" in error && error.code === "ECONNRESET";
}
export function clientDisconnect(): Plugin {
	return {
		name: "vite-plugin-client-disconnect",
		apply: "serve",
		enforce: "post",
		configureServer(server) {
			return () => {
				server.middlewares.use((error: unknown, request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
					if (isClientDisconnect(error, request)) {
						response.destroy();
						return;
					}
					next(error);
				});
			};
		},
	};
}
