import {
	RealtimeError,
	realtimeTransports,
} from "../integrations/realtime/realtime.server";
import { recipientChannel } from "./realtime-hub.server";

export {
	applicationRealtime,
	realtimeEvents,
	recipientChannel,
} from "./realtime-hub.server";
export async function authorizeRealtime(
	request: Request,
	transport: "sse" | "websocket",
) {
	try {
		if (!realtimeTransports().has(transport))
			throw new RealtimeError("configuration");
		const url = new URL(request.url);
		if (
			url.search !== "" ||
			request.headers.has("authorization") ||
			request.headers.has("x-api-key")
		)
			throw new RealtimeError("unauthorized");
		// Same-origin browser sockets/streams; cookie auth never travels in the URL.
		const origin = request.headers.get("origin");
		if (
			origin &&
			origin !==
				new URL(process.env.APP_BASE_URL ?? "http://localhost:3000").origin
		)
			throw new RealtimeError("unauthorized");
		const { auth } = await import("./auth");
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session?.user) throw new RealtimeError("unauthorized");
		const channel = recipientChannel(session.user.id);
		return [channel];
	} catch (error) {
		if (error instanceof RealtimeError) throw error;
		throw new RealtimeError("unavailable");
	}
}
