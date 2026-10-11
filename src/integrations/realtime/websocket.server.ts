import { defineWebSocketHandler } from "nitro";
import {
	authorizedChannels,
	openSocket,
	type Realtime,
} from "./realtime.server";
/** Authorization is entirely application-owned and must complete before accepting. */
export function realtimeWebsocket(
	realtime: Realtime,
	authorize: (request: Request) => Promise<readonly string[]>,
) {
	const connections = new Map<string, ReturnType<typeof openSocket>>();
	return defineWebSocketHandler({
		async upgrade(request) {
			try {
				return {
					context: { channels: authorizedChannels(await authorize(request)) },
				};
			} catch {
				throw new Response("Realtime unavailable", { status: 401 });
			}
		},
		open(peer) {
			try {
				connections.set(
					peer.id,
					openSocket(realtime, peer.context.channels as string[], peer),
				);
			} catch {
				peer.terminate();
			}
		},
		pong(peer) {
			connections.get(peer.id)?.pong();
		},
		message(peer) {
			connections.get(peer.id)?.close();
			connections.delete(peer.id);
		},
		close(peer) {
			connections.get(peer.id)?.close();
			connections.delete(peer.id);
		},
		error(peer) {
			connections.get(peer.id)?.close();
			connections.delete(peer.id);
		},
	});
}
