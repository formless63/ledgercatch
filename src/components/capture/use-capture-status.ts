/**
 * Server-side status of uploaded captures, read from the document review
 * queue ("review" + "done" views). Polls fast while any tracked capture is
 * still being processed, slowly otherwise, and not at all with nothing tracked.
 */
import { useQuery } from "@tanstack/react-query";
import { listDocumentQueue } from "#/features/ingress/documents/review-ui.functions";
import type { DocumentQueueRow } from "#/features/ingress/documents/review-ui.server";

export type CaptureServerState =
	| { state: "processing"; row: DocumentQueueRow }
	| { state: "review"; row: DocumentQueueRow }
	| { state: "failed"; row: DocumentQueueRow }
	| { state: "filed"; row: DocumentQueueRow }
	| { state: "unknown" };

export function useCaptureStatus(captureIds: string[]) {
	const ids = [...new Set(captureIds)].sort();
	const query = useQuery({
		queryKey: ["ledger", "documents", "capture-status", ids],
		enabled: ids.length > 0,
		queryFn: async () => {
			const [review, done] = await Promise.all([
				listDocumentQueue({ data: { view: "review", limit: 200 } }),
				listDocumentQueue({ data: { view: "done", limit: 200 } }),
			]);
			const wanted = new Set(ids);
			const map: Record<string, CaptureServerState> = {};
			for (const row of review.rows)
				if (wanted.has(row.id))
					map[row.id] = {
						state:
							row.status === "pending"
								? "processing"
								: row.status === "failed"
									? "failed"
									: "review",
						row,
					};
			for (const row of done.rows)
				if (wanted.has(row.id)) map[row.id] = { state: "filed", row };
			return map;
		},
		refetchInterval: (q) =>
			Object.values(q.state.data ?? {}).some((s) => s.state === "processing")
				? 3_000
				: 20_000,
		refetchOnWindowFocus: true,
	});
	const get = (captureId: string): CaptureServerState | undefined =>
		query.data ? (query.data[captureId] ?? { state: "unknown" }) : undefined;
	return { ...query, get };
}
