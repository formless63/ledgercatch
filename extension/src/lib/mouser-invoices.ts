/** Invoice identifiers are distinct from Mouser's canonical Web Order number. */
export function mouserPdfInvoiceNumber(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || !/(^|\.)mouser\.(com|ca|co\.uk|de)$/.test(parsed.hostname)) return undefined;
		return /^\/account\/invoices\/detail\/(\d{6,12})\/pdf\/?$/i.exec(parsed.pathname)?.[1];
	} catch {
		return undefined;
	}
}

export function mouserInvoiceOrders(body: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	if (!body || typeof body !== "object" || !("aaData" in body) || !Array.isArray(body.aaData)) return result;
	for (const row of body.aaData) {
		if (!row || typeof row !== "object") continue;
		const id = String(row.WebOrderNumber || row.SalesOrderNumber || "");
		if (!/^\d{6,12}$/.test(id) || !Array.isArray(row.Invoices)) continue;
		for (const invoice of row.Invoices) {
			if (!invoice || typeof invoice !== "object") continue;
			const number = String(invoice.InvoiceNumber ?? "");
			if (/^\d{6,12}$/.test(number)) result[number] = id;
		}
	}
	return result;
}
