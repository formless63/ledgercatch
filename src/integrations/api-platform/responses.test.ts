import { expect, it } from "vitest";
import { z } from "zod";
import { apiErrorResponse, parseJsonBody } from "./responses";

it("keeps unexpected failures safe in both the external envelope and fallback logs", async () => {
	const records: unknown[][] = [];
	const original = console.error;
	console.error = (...fields: unknown[]) => {
		records.push(fields);
	};
	try {
		const response = apiErrorResponse(
			new Error(
				"postgresql://user:database-secret@internal/db app_raw-key-secret",
			),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: "internal_error",
				message: "The request could not be completed.",
			},
		});
		expect(JSON.stringify(records)).not.toMatch(
			/database-secret|app_raw-key-secret|internal\/db|stack/,
		);
	} finally {
		console.error = original;
	}
});

it("bounds actual JSON bytes and read time, including dishonest/missing lengths", async () => {
	const schema = z.object({ name: z.string() });
	const request = (body: string, headers: HeadersInit = {}) =>
		new Request("http://fixture.test", { method: "POST", body, headers });
	await expect(
		parseJsonBody(request('{"name":"ok"}'), schema),
	).resolves.toEqual({ name: "ok" });
	for (const headers of [new Headers(), new Headers({ "content-length": "1" })])
		await expect(
			parseJsonBody(
				request(
					JSON.stringify({ name: "ok", ignored: "x".repeat(70000) }),
					headers,
				),
				schema,
			),
		).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
	let cancelled = false;
	const stalled = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("{"));
		},
		cancel() {
			cancelled = true;
		},
	});
	const slow = new Request("http://fixture.test", {
		method: "POST",
		body: stalled,
		duplex: "half",
	} as RequestInit);
	await expect(
		parseJsonBody(slow, schema, { timeoutMs: 10 }),
	).rejects.toMatchObject({ status: 408, code: "request_timeout" });
	expect(cancelled).toBe(true);
	await expect(parseJsonBody(request("invalid"), schema)).rejects.toMatchObject(
		{ status: 400 },
	);
});
