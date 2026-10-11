/**
 * Minimal single-page PDF writer for tests: Helvetica text runs at absolute
 * positions (PDF coordinates, origin bottom-left). Not for production use.
 */
export function makeTestPdf(
	runs: Array<{ x: number; y: number; size: number; text: string }>,
	page: { width: number; height: number } = { width: 612, height: 792 },
): Uint8Array {
	const escapePdfText = (text: string) =>
		text.replace(/[\\()]/g, (c) => `\\${c}`);
	const content = runs
		.map(
			(run) =>
				`BT /F1 ${run.size} Tf ${run.x} ${run.y} Td (${escapePdfText(run.text)}) Tj ET`,
		)
		.join("\n");
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets)
		out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}
