/**
 * Tracking aggregator providers (#21). Only a 17TRACK-style API is
 * implemented; it is used when TRACKING_API_KEY is set.
 */
import {
	type CarrierId,
	normalizeTrackingState,
	type TrackingState,
} from "./tracking";

export type TrackingQuery = { number: string; carrier: CarrierId };

export type TrackingResult = {
	number: string;
	state: TrackingState;
	statusText: string | null;
	lastEventAt: string | null;
	lastEventText: string | null;
	error: string | null;
};

export interface TrackingProvider {
	readonly id: string;
	/** Max numbers per request. */
	readonly batchSize: number;
	/** Some APIs require registering a number before it can be queried. */
	register(queries: TrackingQuery[]): Promise<{ accepted: string[] }>;
	fetch(queries: TrackingQuery[]): Promise<TrackingResult[]>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 17TRACK carrier codes for numbers we can identify; others auto-detect. */
const SEVENTEEN_CARRIERS: Partial<Record<CarrierId, number>> = {
	usps: 21051,
	ups: 100002,
	fedex: 100003,
	dhl: 100001,
	cainiao: 190271,
	yunexpress: 190008,
};

type SeventeenAccepted = {
	number?: string;
	track_info?: {
		latest_status?: { status?: string; sub_status?: string };
		latest_event?: {
			time_iso?: string;
			time_utc?: string;
			description?: string;
		};
	};
};
type SeventeenRejected = {
	number?: string;
	error?: { code?: number; message?: string };
};
type SeventeenResponse = {
	code?: number;
	data?: { accepted?: SeventeenAccepted[]; rejected?: SeventeenRejected[] };
};

export function parseSeventeenTrackInfo(body: unknown): TrackingResult[] {
	const data = (body as SeventeenResponse)?.data ?? {};
	const out: TrackingResult[] = [];
	for (const row of data.accepted ?? []) {
		if (!row.number) continue;
		const status = row.track_info?.latest_status?.status ?? null;
		const event = row.track_info?.latest_event;
		out.push({
			number: row.number,
			state: normalizeTrackingState(status),
			statusText: status,
			lastEventAt: event?.time_iso ?? event?.time_utc ?? null,
			lastEventText: event?.description?.slice(0, 500) ?? null,
			error: null,
		});
	}
	for (const row of data.rejected ?? []) {
		if (!row.number) continue;
		out.push({
			number: row.number,
			state: "unknown",
			statusText: null,
			lastEventAt: null,
			lastEventText: null,
			error: row.error?.message?.slice(0, 300) ?? "Rejected",
		});
	}
	return out;
}

export function seventeenTrackProvider(options: {
	apiKey: string;
	baseUrl?: string;
	fetchImpl?: FetchLike;
}): TrackingProvider {
	const base = (
		options.baseUrl ?? "https://api.17track.net/track/v2.2"
	).replace(/\/$/, "");
	const doFetch: FetchLike =
		options.fetchImpl ?? ((url, init) => fetch(url, init));
	const call = async (path: string, body: unknown) => {
		const response = await doFetch(`${base}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"17token": options.apiKey,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok)
			throw new Error(`Tracking API ${path} failed: HTTP ${response.status}`);
		return (await response.json()) as unknown;
	};
	const payload = (queries: TrackingQuery[]) =>
		queries.map((q) => {
			const code = SEVENTEEN_CARRIERS[q.carrier];
			return code ? { number: q.number, carrier: code } : { number: q.number };
		});
	return {
		id: "17track",
		batchSize: 40,
		async register(queries) {
			if (queries.length === 0) return { accepted: [] };
			const body = (await call(
				"/register",
				payload(queries),
			)) as SeventeenResponse;
			const accepted = (body.data?.accepted ?? [])
				.map((r) => r.number)
				.filter((n): n is string => Boolean(n));
			// "Already registered" rejections count as accepted.
			for (const r of body.data?.rejected ?? [])
				if (
					r.number &&
					/already|registered|-18019901/i.test(
						`${r.error?.code ?? ""} ${r.error?.message ?? ""}`,
					)
				)
					accepted.push(r.number);
			return { accepted };
		},
		async fetch(queries) {
			if (queries.length === 0) return [];
			return parseSeventeenTrackInfo(
				await call("/gettrackinfo", payload(queries)),
			);
		},
	};
}

/** The configured provider, or null (refresh is then skipped). */
export function configuredTrackingProvider(
	env: Record<string, string | undefined> = process.env,
): TrackingProvider | null {
	const apiKey = env.TRACKING_API_KEY?.trim();
	if (!apiKey) return null;
	return seventeenTrackProvider({
		apiKey,
		baseUrl: env.TRACKING_API_BASE_URL?.trim() || undefined,
	});
}
