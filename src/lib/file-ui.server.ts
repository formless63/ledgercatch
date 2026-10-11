import { db } from "../db";
import { FileError } from "../integrations/file-ui/contract";
import { getFileStorage } from "../integrations/file-ui/storage.server";
import { createFileWorkflow } from "../integrations/file-ui/workflow.server";
import { auth } from "./auth";
import { createPostgresFileMetadata } from "./file-ui-metadata.server";
export const referenceFiles = createFileWorkflow({
	metadata: createPostgresFileMetadata(db),
	storage: getFileStorage,
	authorize: async (ctx) => Boolean(ctx.owner),
});
export async function fileUiHttp(request: Request, path: string) {
	try {
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session?.user)
			return Response.json({ error: "unauthenticated" }, { status: 401 });
		const ctx = {
			owner: session.user.id,
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
		};
		const url = new URL(request.url);
		// Cookie mutations require exact same-origin and an explicit non-simple request header.
		if (
			request.method !== "GET" &&
			(request.headers.get("origin") !== url.origin ||
				request.headers.get("x-file-ui") !== "1")
		)
			throw new FileError("forbidden");
		const id = url.searchParams.get("id") ?? "";
		if ([...url.searchParams.keys()].some((key) => key !== "id"))
			throw new FileError("invalid_input");
		if (request.method === "GET" && path === "list")
			return Response.json(await referenceFiles.list(ctx), {
				headers: { "Cache-Control": "private, no-store" },
			});
		if (request.method === "GET" && path === "download") {
			const file = await referenceFiles.download(ctx, id);
			return new Response(file.body.transformToWebStream(), {
				headers: file.headers,
			});
		}
		if (request.method === "POST" && path === "upload") {
			let name: string;
			try {
				name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
			} catch {
				throw new FileError("invalid_input");
			}
			const value = await referenceFiles.upload(ctx, {
				token: request.headers.get("idempotency-key") ?? "",
				name,
				type: request.headers.get("content-type") ?? "",
				body: request.body,
			});
			return Response.json(value);
		}
		if (request.method === "POST" && path === "remove")
			return Response.json(await referenceFiles.remove(ctx, id));
		throw new FileError("not_found");
	} catch (error) {
		const code = error instanceof FileError ? error.code : "unavailable";
		return Response.json(
			{ error: code },
			{
				status:
					code === "not_found"
						? 404
						: code === "forbidden"
							? 403
							: code === "conflict"
								? 409
								: code === "too_large"
									? 413
									: code === "invalid_input"
										? 400
										: 503,
				headers: { "Cache-Control": "no-store" },
			},
		);
	}
}
