import { InvoiceNinjaError } from "./errors";
/** Preserve provider JSON numeric lexemes as strings. Never route financial values through Number. */
export function parseExactJson(bytes: Uint8Array): unknown {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		let index = 0;
		let depth = 0;
		const ws = () => {
			while (/[\t\n\r ]/.test(text[index] ?? "!")) index++;
		};
		const string = (): string => {
			const start = index++;
			while (index < text.length) {
				const c = text[index++];
				if (c === "\\") index++;
				else if (c === '"')
					return JSON.parse(text.slice(start, index)) as string;
			}
			throw 0;
		};
		const value = (): unknown => {
			ws();
			if (++depth > 64) throw 0;
			try {
				const c = text[index];
				if (c === '"') return string();
				if (c === "{" || c === "[") {
					index++;
					const object =
						c === "{" ? (Object.create(null) as Record<string, unknown>) : [];
					ws();
					if (text[index] === (c === "{" ? "}" : "]")) {
						index++;
						return object;
					}
					for (;;) {
						ws();
						if (c === "{") {
							if (text[index] !== '"') throw 0;
							const key = string();
							ws();
							if (text[index++] !== ":") throw 0;
							if (Object.hasOwn(object, key)) throw 0;
							(object as Record<string, unknown>)[key] = value();
						} else {
							(object as unknown[]).push(value());
						}
						ws();
						const end = text[index++];
						if (end === (c === "{" ? "}" : "]")) return object;
						if (end !== ",") throw 0;
					}
				}
				for (const [literal, result] of [
					["true", true],
					["false", false],
					["null", null],
				] as const) {
					if (text.startsWith(literal, index)) {
						index += literal.length;
						return result;
					}
				}
				const number =
					/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
						text.slice(index),
					);
				if (!number) throw 0;
				index += number[0].length;
				return number[0];
			} finally {
				depth--;
			}
		};
		const result = value();
		ws();
		if (index !== text.length) throw 0;
		return result;
	} catch {
		throw new InvoiceNinjaError("unsupported");
	}
}
export function outputDecimal(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (
		typeof value !== "string" ||
		!/^-?(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,8})?$/.test(value)
	)
		throw new InvoiceNinjaError("unsupported");
	let result = value.includes(".")
		? value.replace(/0+$/, "").replace(/\.$/, "")
		: value;
	if (result === "-0") result = "0";
	return result;
}
