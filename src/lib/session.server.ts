import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";

/** Current Better Auth user for the request, or null. */
export async function currentUser() {
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	return session?.user ?? null;
}

export async function requireUser() {
	const user = await currentUser();
	if (!user) throw new Error("UNAUTHORIZED");
	return user;
}
