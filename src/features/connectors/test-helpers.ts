/** Test-only fetch mock helpers for connector tests. */
export interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export function mockFetch(responder: Responder): {
	fetch: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => {
			headers[k] = v;
		});
		const call: RecordedCall = {
			url: String(input),
			method: (init?.method ?? "GET").toUpperCase(),
			headers,
			body: init?.body,
		};
		calls.push(call);
		return responder(call);
	};
	return { fetch: impl as typeof fetch, calls };
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
