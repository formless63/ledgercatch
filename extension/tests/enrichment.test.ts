import { enrichmentNextResponseSchema, enrichmentResultRequestSchema } from "@app/shared/capture";
import { describe, expect, it } from "vitest";
import {
	checkTask,
	classifyFetch,
	DomainThrottle,
	hasOrderData,
	htmlTitle,
	MIN_DOMAIN_INTERVAL_MS,
	resultFor,
	stopsDomain,
	storeDomain,
	unfetchableSources,
} from "@/lib/enrichment";

const AMAZON_ID = "112-1234567-1234567";
const AMAZON_URL = `https://www.amazon.com/gp/your-account/order-details?orderID=${AMAZON_ID}`;
const detailHtml = `<html><head><title>Order Details</title><script>var x="$1"</script></head>
<body><div class="order-id">Order # ${AMAZON_ID}</div><span>Grand Total: $23.45</span></body></html>`;

describe("task URL checks", () => {
	it("accepts https URLs on the task's store domains", () => {
		const check = checkTask({ source: "amazon", url: AMAZON_URL });
		expect(check.ok && check.domain).toBe("amazon.com");
		expect(storeDomain("https://order.ebay.co.uk/ord/show?orderId=1")).toBe("ebay.co.uk");
		expect(storeDomain("https://www.aliexpress.com/p/order/detail.html?orderId=1")).toBe("aliexpress.com");
	});
	it("rejects other hosts, other stores, http and credentials", () => {
		expect(checkTask({ source: "amazon", url: "https://evil.example/order" }).ok).toBe(false);
		expect(checkTask({ source: "ebay", url: AMAZON_URL }).ok).toBe(false);
		expect(checkTask({ source: "amazon", url: AMAZON_URL.replace("https:", "http:") }).ok).toBe(false);
		expect(checkTask({ source: "amazon", url: "https://u:p@www.amazon.com/x" }).ok).toBe(false);
		expect(checkTask({ source: "amazon", url: "https://amazon.com.evil.example/x" }).ok).toBe(false);
	});
});

describe("DomainThrottle", () => {
	it("spaces requests per domain and books slots ahead", () => {
		const t = new DomainThrottle(3000);
		expect(t.reserve("amazon.com", 1000)).toBe(0);
		expect(t.reserve("amazon.com", 1000)).toBe(3000);
		expect(t.reserve("amazon.com", 1500)).toBe(5500);
		expect(t.reserve("ebay.com", 1500)).toBe(0);
		expect(t.reserve("amazon.com", 20_000)).toBe(0);
	});
	it("defaults to 3 s", () => {
		const t = new DomainThrottle();
		t.reserve("x", 0);
		expect(t.reserve("x", 0)).toBe(MIN_DOMAIN_INTERVAL_MS);
		expect(MIN_DOMAIN_INTERVAL_MS).toBe(3000);
	});
});

const facts = (over: Partial<Parameters<typeof classifyFetch>[0]> = {}) => ({
	status: 200,
	finalUrl: AMAZON_URL,
	redirected: false,
	contentType: "text/html; charset=utf-8",
	html: detailHtml,
	...over,
});

describe("classifyFetch", () => {
	it("accepts a page with the order id and an amount", () => {
		expect(classifyFetch(facts(), AMAZON_ID)).toEqual({ kind: "ok" });
		expect(hasOrderData(detailHtml, AMAZON_ID)).toBe(true);
	});
	it("detects sign-in redirects and 4xx", () => {
		const login = classifyFetch(
			facts({ redirected: true, finalUrl: "https://www.amazon.com/ap/signin?openid.return_to=x", html: "<form>" }),
			AMAZON_ID,
		);
		expect(login.kind).toBe("signed_out");
		expect(classifyFetch(facts({ status: 403, html: "" }), AMAZON_ID).kind).toBe("signed_out");
		expect(classifyFetch(facts({ status: 404, html: "" }), AMAZON_ID).kind).toBe("signed_out");
		expect(classifyFetch(facts({ html: '<form><input type="password" name="p"></form>' }), AMAZON_ID).kind).toBe(
			"signed_out",
		);
	});
	it("detects rate limits, server errors and empty client-rendered shells", () => {
		expect(
			classifyFetch(
				facts({ redirected: true, finalUrl: "https://pages.ebay.com/limitexceeded.html" }),
				"12-34567-89012",
			).kind,
		).toBe("blocked");
		expect(classifyFetch(facts({ status: 429 }), AMAZON_ID).kind).toBe("blocked");
		const ebayId = "12-34567-89012";
		expect(
			classifyFetch(
				facts({ redirected: true, finalUrl: "https://www.ebay.com/splashui/challenge?ap=1&appName=orch" }),
				ebayId,
			).kind,
		).toBe("blocked");
		expect(
			classifyFetch(facts({ html: "<html><head><title>Pardon Our Interruption...</title></head></html>" }), ebayId)
				.kind,
		).toBe("blocked");
		expect(classifyFetch(facts({ status: 503, html: "" }), AMAZON_ID).kind).toBe("http_error");
		const shell = `<html><body><div id="root"></div><script>window.orderId="${AMAZON_ID}";price="$5"</script></body></html>`;
		expect(classifyFetch(facts({ html: shell }), AMAZON_ID).kind).toBe("no_data");
		expect(classifyFetch(facts({ contentType: "application/json" }), AMAZON_ID).kind).toBe("no_data");
	});
	it("stops a domain only for sign-in and rate limits", () => {
		expect(stopsDomain({ kind: "signed_out", detail: "" })).toBe(true);
		expect(stopsDomain({ kind: "blocked", detail: "" })).toBe(true);
		expect(stopsDomain({ kind: "no_data", detail: "" })).toBe(false);
		expect(stopsDomain({ kind: "http_error", detail: "" })).toBe(false);
	});
});

describe("result handling", () => {
	const captureId = "11111111-2222-4333-8444-555555555555";
	it("maps outcomes to valid server results", () => {
		const cases = [
			[
				{ kind: "captured", captureId, via: "fetch" },
				{ status: "done", captureId },
			],
			[
				{ kind: "verdict", verdict: { kind: "signed_out", detail: "HTTP 403" } },
				{ status: "skipped", error: "signed out (HTTP 403)" },
			],
			[
				{ kind: "verdict", verdict: { kind: "no_data", detail: "no order data in fetched page" } },
				{ status: "failed", error: "no order data in fetched page" },
			],
			[
				{ kind: "invalid", reason: "URL is not on the store's domain" },
				{ status: "failed", error: "URL is not on the store's domain" },
			],
			[
				{ kind: "skipped_domain", reason: "signed out (earlier request to amazon.com)" },
				{ status: "skipped", error: "signed out (earlier request to amazon.com)" },
			],
		] as const;
		for (const [outcome, expected] of cases) {
			const result = resultFor(outcome);
			expect(result).toEqual(expected);
			expect(enrichmentResultRequestSchema.safeParse(result).success).toBe(true);
		}
		expect(resultFor({ kind: "error", message: "x".repeat(5000) }).error).toHaveLength(2000);
	});
	it("parses the next-tasks response and extracts titles", () => {
		const parsed = enrichmentNextResponseSchema.parse({
			tasks: [{ id: captureId, source: "amazon", externalOrderId: AMAZON_ID, url: AMAZON_URL }],
		});
		expect(parsed.pending).toBe(0);
		expect(htmlTitle(detailHtml)).toBe("Order Details");
	});
});

describe("unfetchableSources", () => {
	it("leaves client-rendered stores to the server while tabs are off", () => {
		expect(unfetchableSources({ fetchDetailsInTabs: false }).sort()).toEqual(["alibaba", "aliexpress", "digikey"]);
		expect(unfetchableSources({ fetchDetailsInTabs: true })).toEqual([]);
	});
});
