import { describe, expect, test } from "vitest";
import {
	decodeSearchCursor,
	encodeSearchCursor,
	parseSearchInput,
	SearchError,
} from "./validation";

const timestamp = "2026-01-01T00:00:00.000001Z";
const golden =
	"WzEsMC4yODU3MTQyOTg0ODY3MDk2LCIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMDAwMVoiLCIgzqnnlYzwn5iAICJd";
const token = (tuple: unknown) =>
	Buffer.from(JSON.stringify(tuple)).toString("base64url");
describe("canonical Search wire format", () => {
	test("shared golden and native float4 widening", () => {
		const rank = Math.fround(Number("0.2857143"));
		const cursor = { rank, updatedAt: timestamp, id: " Ω界😀 " };
		expect(rank).toBe(0.2857142984867096);
		const bytes = Buffer.alloc(4);
		bytes.writeFloatBE(rank);
		expect(bytes.toString("hex")).toBe("3e924925");
		expect(encodeSearchCursor(cursor)).toBe(golden);
		expect(decodeSearchCursor(golden)).toEqual(cursor);
	});
	test("float4 extremes and opaque IDs round trip", () => {
		for (const rank of [
			0, 0.5, 0.3333333432674408, 0.6666666865348816, 1.401298464324817e-45, 1,
		]) {
			for (const id of [" ", " Ω界😀 ", "界".repeat(128), "😀".repeat(64)]) {
				const cursor = { rank, updatedAt: timestamp, id };
				expect(decodeSearchCursor(encodeSearchCursor(cursor))).toEqual(cursor);
			}
		}
		for (const updatedAt of [
			"0001-01-01T00:00:00.000000Z",
			"2000-02-29T23:59:59.999999Z",
			"9999-12-31T23:59:59.999999Z",
		]) {
			expect(
				decodeSearchCursor(encodeSearchCursor({ rank: 0, updatedAt, id: "x" }))
					.updatedAt,
			).toBe(updatedAt);
		}
	});
	test("rejects alternate JSON/base64, invalid Unicode, bounds and calendar", () => {
		const tuple = [1, 0.5, timestamp, "x"];
		const invalid = [
			`${golden}=`,
			` ${golden}`,
			"a".repeat(2048),
			"a".repeat(2049),
			token([...tuple, 1]),
			token([2, ...tuple.slice(1)]),
			Buffer.from(JSON.stringify(tuple, null, 2)).toString("base64url"),
			Buffer.from(`[1,5e-1,"${timestamp}","x"]`).toString("base64url"),
			Buffer.from(`[1,-0,"${timestamp}","x"]`).toString("base64url"),
			Buffer.from([0xff]).toString("base64url"),
		];
		for (const rank of ["0.5", 0.2857143, 0.3333333333333333, -1, 2])
			invalid.push(token([1, rank, timestamp, "x"]));
		for (const id of [
			"",
			"x".repeat(129),
			"😀".repeat(65),
			"\u0000",
			"\u007f",
			"\u0080",
			"\u009f",
			"\ud800",
			"\udfff",
		])
			invalid.push(token([1, 0.5, timestamp, id]));
		for (const time of [
			"0000-01-01T00:00:00.000000Z",
			"2026-02-29T00:00:00.000001Z",
			"1900-02-29T00:00:00.000001Z",
			"2026-04-31T00:00:00.000001Z",
			"2026-01-01T24:00:00.000001Z",
			"2026-01-01T00:00:60.000001Z",
			"2026-01-01T00:00:00.001Z",
		])
			invalid.push(token([1, 0.5, time, "x"]));
		for (const value of invalid)
			expect(() => decodeSearchCursor(value)).toThrow(SearchError);
		for (const rank of [-0, NaN, Infinity, 0.2857143])
			expect(() =>
				encodeSearchCursor({ rank, updatedAt: timestamp, id: "x" }),
			).toThrow(SearchError);
	});
	test("query bounds count UTF16 after trimming", () => {
		expect(parseSearchInput({ query: " Ω界 " })).toEqual({
			query: "Ω界",
			limit: 25,
		});
		expect(
			parseSearchInput({ query: "😀".repeat(128), limit: 100 }).query.length,
		).toBe(256);
		for (const query of [" x ", "x".repeat(257), "a\0", "a\ud800", "a\udfff"])
			expect(() => parseSearchInput({ query })).toThrow(SearchError);
	});
});
