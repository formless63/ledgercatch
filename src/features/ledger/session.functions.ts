import { createServerFn } from "@tanstack/react-start";

export const getSessionUser = createServerFn({ method: "GET" }).handler(
	async () => {
		const { getRequestHeaders } = await import("@tanstack/react-start/server");
		const { auth } = await import("#/lib/auth");
		const session = await auth.api.getSession({ headers: getRequestHeaders() });
		return session?.user
			? {
					id: session.user.id,
					name: session.user.name,
					email: session.user.email,
				}
			: null;
	},
);
