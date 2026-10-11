/**
 * Parsers for server-side capture kinds. process.server.ts asks here first;
 * returning null falls through to the store/generic parsers.
 */
import type { ParsedOrder } from "#/features/parsing/types";
import type { CaptureRow, KindParseOutcome } from "./types";

export async function parseCaptureByKind(
	capture: CaptureRow,
): Promise<KindParseOutcome | null> {
	switch (capture.kind) {
		case "email":
			return (await import("./email/parse.server")).parseEmailCapture(capture);
		case "document":
			return (await import("./documents/parse.server")).parseDocumentCapture(
				capture,
			);
		case "import_row":
			return (await import("./imports/parse.server")).parseImportRowCapture(
				capture,
			);
		case "agent": {
			// Structured orders posted by an API client are trusted as-is.
			const orders =
				(capture.bodyJson as { orders?: ParsedOrder[] } | null)?.orders ?? [];
			return {
				result: orders.length
					? { outcome: "orders", orders, warnings: [] }
					: { outcome: "no_orders", reason: "No orders in payload" },
				parserId: "agent",
				version: 1,
			};
		}
		default:
			return null;
	}
}
