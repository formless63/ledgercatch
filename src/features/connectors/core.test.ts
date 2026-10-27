import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto.server";
import { boundedFetch, httpError, sanitizeRemoteMessage } from "./http.server";
import { buildContext, getProvider, listProviders } from "./registry";
import { mockFetch } from "./test-helpers";
import { ConnectorError, minorToDecimalString, resolveMapping } from "./types";

describe("crypto", () => {
	const saved = { ...process.env };
	beforeEach(() => {
		process.env.APP_ENCRYPTION_KEY = "k".repeat(40);
	});
	afterEach(() => {
		process.env = { ...saved };
	});

	it("round-trips JSON", () => {
		const ct = encryptSecret({ token: "test_secret", n: 1 });
		expect(ct.startsWith("v1.")).toBe(true);
		expect(ct.split(".")).toHaveLength(4);
		expect(ct).not.toContain("test_secret");
		expect(decryptSecret(ct)).toEqual({ token: "test_secret", n: 1 });
	});

	it("uses a fresh IV each time", () => {
		expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
	});

	it("reads a predecessor credential without rewriting it or weakening authentication", () => {
		// Fixed synthetic fixture produced by the predecessor implementation.
		const legacy =
			"v1.BwcHBwcHBwcHBwcH.7Pltck-hSXstQVtagGMkyA.KHbcq1oX9bSuph5ixAKF726BXh_smM-XV_HWzsYk_kizrg";
		expect(decryptSecret(legacy)).toEqual({ token: "synthetic-legacy-token" });
		const parts = legacy.split(".");
		const bytes = Buffer.from(parts[3] ?? "", "base64url");
		bytes[0] = (bytes[0] ?? 0) ^ 1;
		parts[3] = bytes.toString("base64url");
		expect(() => decryptSecret(parts.join("."))).toThrow(/tampered/);
		process.env.APP_ENCRYPTION_KEY = "z".repeat(40);
		expect(() => decryptSecret(legacy)).toThrow(/key changed/);
		process.env.APP_ENCRYPTION_KEY = "k".repeat(40);
		expect(decryptSecret(legacy)).toEqual({ token: "synthetic-legacy-token" });
	});

	it("detects tampering", () => {
		const ct = encryptSecret({ a: 1 });
		const [v, iv, tag, data] = ct.split(".") as [
			string,
			string,
			string,
			string,
		];
		const flipped = Buffer.from(data, "base64url");
		flipped[0] = (flipped[0] ?? 0) ^ 1;
		expect(() =>
			decryptSecret([v, iv, tag, flipped.toString("base64url")].join(".")),
		).toThrow(/tampered/);
		expect(() => decryptSecret(`v2.${iv}.${tag}.${data}`)).toThrow(/format/);
	});

	it("fails with a different key", () => {
		const ct = encryptSecret({ a: 1 });
		process.env.APP_ENCRYPTION_KEY = "z".repeat(40);
		expect(() => decryptSecret(ct)).toThrow(/key changed/);
	});

	it("falls back to BETTER_AUTH_SECRET and validates length", () => {
		delete process.env.APP_ENCRYPTION_KEY;
		process.env.BETTER_AUTH_SECRET = "b".repeat(32);
		expect(decryptSecret(encryptSecret(1))).toBe(1);
		process.env.BETTER_AUTH_SECRET = "short";
		expect(() => encryptSecret(1)).toThrow(/at least 32/);
		delete process.env.BETTER_AUTH_SECRET;
		expect(() => encryptSecret(1)).toThrow(/APP_ENCRYPTION_KEY/);
	});
});

describe("minorToDecimalString", () => {
	it.each([
		[12345, "USD", "123.45"],
		[5, "USD", "0.05"],
		[0, "EUR", "0.00"],
		[-150, "usd", "-1.50"],
		[1200, "JPY", "1200"],
		[1234, "KWD", "1.234"],
		[10n ** 15n, "USD", "10000000000000.00"],
	])("%s %s → %s", (minor, cur, out) => {
		expect(minorToDecimalString(minor, cur)).toBe(out);
	});

	it("rejects non-integers", () => {
		expect(() => minorToDecimalString(1.5, "USD")).toThrow(ConnectorError);
	});
});

describe("resolveMapping", () => {
	const cfg = {
		categoryAccountMap: { cat1: "601" },
		paymentAccountMap: { pm1: "1010" },
		defaultExpenseAccountId: "699",
		defaultPaymentAccountId: "2020",
	};
	it("maps then falls back to defaults", () => {
		expect(
			resolveMapping(cfg, { categoryId: "cat1", paymentMethodId: "pm1" }),
		).toEqual({
			expenseAccountId: "601",
			paymentAccountId: "1010",
		});
		expect(
			resolveMapping(cfg, { categoryId: "x", paymentMethodId: null }),
		).toEqual({
			expenseAccountId: "699",
			paymentAccountId: "2020",
		});
		expect(resolveMapping({}, {})).toEqual({});
	});
});

describe("boundedFetch", () => {
	it("refuses cross-host redirects", async () => {
		const { fetch } = mockFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/x" },
				}),
		);
		await expect(
			boundedFetch("https://good.example/a", { label: "T", fetch }),
		).rejects.toMatchObject({ code: "validation" });
	});

	it("follows same-host GET redirects", async () => {
		const { fetch, calls } = mockFetch((c) =>
			c.url.endsWith("/a")
				? new Response(null, { status: 301, headers: { location: "/b" } })
				: new Response("ok"),
		);
		const res = await boundedFetch("https://good.example/a", {
			label: "T",
			fetch,
		});
		expect(res.text).toBe("ok");
		expect(calls.map((c) => c.url)).toEqual([
			"https://good.example/a",
			"https://good.example/b",
		]);
	});

	it("caps response size", async () => {
		const { fetch } = mockFetch(() => new Response("x".repeat(100)));
		await expect(
			boundedFetch("https://h.example/", {
				label: "T",
				fetch,
				maxResponseBytes: 10,
			}),
		).rejects.toThrow(/exceeded/);
	});

	it("times out as a retryable network error", async () => {
		const fetch = ((_u: string, init: RequestInit) =>
			new Promise((_r, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			})) as unknown as typeof globalThis.fetch;
		await expect(
			boundedFetch("https://h.example/", { label: "T", fetch, timeoutMs: 20 }),
		).rejects.toMatchObject({ code: "network", retryable: true });
	});

	it("maps HTTP errors with sanitized messages", () => {
		const err = httpError(
			{
				status: 422,
				text: JSON.stringify({
					message: "Bad",
					errors: { date: ["is invalid"] },
				}),
			},
			"IN",
		);
		expect(err).toMatchObject({ code: "validation", retryable: false });
		expect(err.message).toBe("IN returned HTTP 422: Bad; date: is invalid");
		expect(
			httpError({ status: 503, text: "<h1>down</h1>" }, "IN").retryable,
		).toBe(true);
		expect(sanitizeRemoteMessage("token SECRET123", ["SECRET123"])).toBe(
			"token ***",
		);
	});
});

describe("registry", () => {
	it("lists and validates providers", () => {
		expect(listProviders().map((p) => p.id)).toEqual([
			"custom_http",
			"invoice_ninja",
		]);
		expect(getProvider("nope")).toBeUndefined();
		const p = getProvider("invoice_ninja");
		const ctx = buildContext(
			p,
			{ baseUrl: "https://a.example/" },
			{ apiToken: "t".repeat(43) },
		);
		expect(ctx.config).toMatchObject({
			baseUrl: "https://a.example",
			categoryAccountMap: {},
		});
		expect(() =>
			buildContext(p, { baseUrl: "ftp://x" }, { token: "bad" }),
		).toThrow(ConnectorError);
	});
});
