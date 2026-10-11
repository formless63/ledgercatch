import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Chart } from "./Chart";

const data = [
	{ label: "Jan", value: 2 },
	{ label: "Feb", value: 5 },
];

describe("Chart", () => {
	it("renders deterministic SSR fallback with accessible names and table data", () => {
		const html = renderToString(
			<>
				<Chart data={data} title="Revenue" description="Monthly revenue" />
				<Chart data={data} title="Orders" />
			</>,
		);
		expect(html).toContain('viewBox="0 0 100 40"');
		expect(html).toContain("Monthly revenue");
		expect(html).toContain('scope="row"');
		expect((html.match(/id="[^"]+"/g) ?? []).length).toBeGreaterThanOrEqual(3);
	});

	it("preserves missing values in the fallback and excludes invalid points from chart data", () => {
		const html = renderToString(
			<Chart
				data={[
					{ label: "good", value: 3 },
					{ label: "missing", value: null },
					{ label: "bad", value: Number.NaN },
				]}
				kind="bar"
				title="Values"
			/>,
		);
		expect(html).toContain("Not available");
		expect(html).toContain("missing");
		expect(html).not.toContain("NaN");
		expect(html).not.toContain("animate");
	});
});
