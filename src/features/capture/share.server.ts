import { apiErrorResponse } from "#/integrations/api-platform/responses";
/**
 * Web Share Target endpoint: POST /app/capture (multipart, field `file`).
 *
 * The phone share sheet navigates the installed PWA to this URL with the
 * shared files. Handled entirely on the server — the service worker never
 * sees or stores the bytes (pwa-offline contract). Files are forwarded to
 * the regular document upload handler as receipts, then the browser is
 * redirected (303) to GET /app/capture?shared=<captureIds> to show status.
 *
 * CSRF: only browser-initiated (`Sec-Fetch-Site: none`, the share sheet) or
 * same-origin POSTs are accepted; session cookies are SameSite=Lax anyway.
 */
import { auth } from "#/lib/auth";
import { readMultipart } from "#/lib/multipart.server";

const CAPTURE_PATH = "/app/capture";
const MAX_SHARED_FILES = 10;

function redirect(request: Request, search: Record<string, string>) {
	const url = new URL(CAPTURE_PATH, request.url);
	for (const [key, value] of Object.entries(search))
		url.searchParams.set(key, value);
	return new Response(null, {
		status: 303,
		headers: { location: `${url.pathname}${url.search}` },
	});
}

export async function handleShareTarget(request: Request) {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "none" && site !== "same-origin")
		return new Response("Cross-site share rejected", { status: 403 });
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user?.id)
		return new Response(null, {
			status: 303,
			headers: {
				location: `/?redirect=${encodeURIComponent(CAPTURE_PATH)}`,
			},
		});
	let form: FormData;
	try {
		form = await readMultipart(request, 100 * 1024 * 1024);
	} catch (error) {
		return apiErrorResponse(error);
	}
	const files = (form?.getAll("file") ?? [])
		.filter((f): f is File => f instanceof File && f.size > 0)
		.slice(0, MAX_SHARED_FILES);
	if (!files.length) return redirect(request, { sharedFailed: "0" });

	const forwarded = new FormData();
	for (const file of files) forwarded.append("file", file, file.name);
	forwarded.append("kind", "receipt");
	forwarded.append("source", "generic");
	const text = [form?.get("title"), form?.get("text"), form?.get("url")]
		.filter((v): v is string => typeof v === "string" && v.trim() !== "")
		.join(" — ")
		.slice(0, 2000);
	if (text) forwarded.append("note", text);

	const cookie = request.headers.get("cookie");
	const inner = new Request(new URL("/api/import/document", request.url), {
		method: "POST",
		headers: cookie ? { cookie } : {},
		body: forwarded,
	});
	const { uploadImportDocuments } = await import(
		"#/features/ingress/documents/upload-http.server"
	);
	const response = await uploadImportDocuments(inner);
	const body = (await response.json().catch(() => ({}))) as {
		results?: Array<{ ok: boolean; captureId?: string }>;
	};
	const results = body.results ?? [];
	const ok = results
		.filter((r) => r.ok && r.captureId)
		.map((r) => r.captureId as string);
	return redirect(request, {
		...(ok.length ? { shared: ok.join(",") } : {}),
		sharedFailed: String(files.length - ok.length),
	});
}
