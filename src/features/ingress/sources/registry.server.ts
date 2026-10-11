import type { IngressSourceKind } from "../schema";
import type { SourceModule } from "../types";

/** Lazily loaded pollable source modules. Push-only kinds return null. */
export async function getSourceModule(
	kind: IngressSourceKind,
): Promise<SourceModule | null> {
	switch (kind) {
		case "imap":
			return (await import("./imap.server")).imapSource;
		case "paperless":
			return (await import("./paperless.server")).paperlessSource;
		case "digikey_api":
			return (await import("./digikey.server")).digikeySource;
		case "inbound_email":
			return null;
	}
}
