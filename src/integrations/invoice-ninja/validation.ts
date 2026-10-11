import { z } from "zod";
import { InvoiceNinjaError } from "./errors";

export function isWellFormed(s: string) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = s.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
		} else if (c >= 0xdc00 && c <= 0xdfff) return false;
	}
	return true;
}
export function hasControls(s: string, plainText = false) {
	return Array.from(s).some((c) => {
		const n = c.charCodeAt(0);
		return (
			(n < 32 && !(plainText && (n === 9 || n === 10))) ||
			(n >= 127 && n <= 159)
		);
	});
}
export const opaqueId = z
	.string()
	.min(1)
	.max(128)
	.refine((s) => isWellFormed(s) && !hasControls(s));
export const connectionId = z
	.string()
	.max(64)
	.regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
export const uuid = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
export const scopeSchema = z.strictObject({
	kind: z.enum(["user", "tenant"]),
	id: opaqueId,
});
export type Scope = z.infer<typeof scopeSchema>;
export type TrustedContext = {
	actorUserId: string;
	scope: Scope;
	signal?: AbortSignal;
};
export const bindingRef = z.strictObject({ bindingId: uuid });
export const clientReconciliation = z.strictObject({ clientBindingId: uuid });
export const invoiceReconciliation = z.strictObject({ invoiceBindingId: uuid });
export const operationRef = z.strictObject({ operationId: uuid });
export const listInput = z.strictObject({
	limit: z.number().int().min(1).max(100).default(25),
	cursor: z.string().max(2048).optional(),
});
const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => {
		const d = new Date(`${s}T00:00:00.000Z`);
		return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
	});
export function normalizeDecimal(s: string) {
	return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
const decimal = z
	.string()
	.regex(/^(0|[1-9][0-9]{0,13})([.][0-9]{1,4})?$/)
	.transform(normalizeDecimal);
export const draftInput = z
	.strictObject({
		clientBindingId: uuid,
		idempotencyKey: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9._:-]+$/),
		invoiceDate: date,
		dueDate: date.optional(),
		numbering: z.discriminatedUnion("mode", [
			z.strictObject({ mode: z.literal("provider") }),
			z.strictObject({
				mode: z.literal("explicit"),
				number: z
					.string()
					.min(1)
					.max(64)
					.regex(/^[A-Za-z0-9._/-]+$/),
			}),
		]),
		lines: z
			.array(
				z.strictObject({
					description: z
						.string()
						.min(1)
						.max(2000)
						.refine((s) => isWellFormed(s) && !hasControls(s, true)),
					quantity: decimal.refine((s) => s !== "0"),
					unitCost: decimal,
				}),
			)
			.min(1)
			.max(100),
	})
	.refine((v) => !v.dueDate || v.dueDate >= v.invoiceDate);
export type DraftInput = z.output<typeof draftInput>;
export function parse<T extends z.ZodType>(
	schema: T,
	value: unknown,
): z.output<T> {
	const result = schema.safeParse(value);
	if (!result.success) throw new InvoiceNinjaError("invalid_input");
	return result.data;
}
export function decodeCursor(s: string): [string, string] {
	try {
		if (s.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(s)) throw 0;
		const bytes = Buffer.from(s, "base64url");
		if (bytes.toString("base64url") !== s) throw 0;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const tuple: unknown = JSON.parse(text);
		if (
			!Array.isArray(tuple) ||
			tuple.length !== 3 ||
			tuple[0] !== 1 ||
			typeof tuple[1] !== "string" ||
			!uuid.safeParse(tuple[2]).success
		)
			throw 0;
		if (
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(tuple[1]) ||
			new Date(tuple[1]).toISOString() !== tuple[1]
		)
			throw 0;
		if (JSON.stringify(tuple) !== text) throw 0;
		return [tuple[1], tuple[2]];
	} catch {
		throw new InvoiceNinjaError("invalid_input");
	}
}
export function encodeCursor(at: Date, id: string) {
	const s = Buffer.from(JSON.stringify([1, at.toISOString(), id])).toString(
		"base64url",
	);
	decodeCursor(s);
	return s;
}
