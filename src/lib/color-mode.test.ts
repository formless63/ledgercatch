import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import {
	type ColorPolicy,
	initialColorModeScript,
	resolvedMode,
	resolvePreference,
} from "./color-mode";

const selectable: ColorPolicy = {
	supported: ["light", "dark"],
	default: "system",
	userSelectable: true,
};
describe("color mode policy and pre-paint script", () => {
	test.each([
		"light",
		"dark",
		"system",
	] as const)("accepts persisted %s", (preference) => {
		expect(resolvePreference(preference, selectable)).toBe(preference);
	});
	test("system follows media while explicit modes do not", () => {
		expect(resolvedMode("system", true)).toBe("dark");
		expect(resolvedMode("system", false)).toBe("light");
		expect(resolvedMode("light", true)).toBe("light");
		expect(resolvedMode("dark", false)).toBe("dark");
	});
	test("fixed/single-mode policies reject unsupported saved values", () => {
		for (const mode of ["light", "dark"] as const) {
			expect(
				resolvePreference(mode === "dark" ? "light" : "dark", {
					supported: [mode],
					default: mode,
					userSelectable: true,
				}),
			).toBe(mode);
			expect(
				resolvePreference("dark", {
					...selectable,
					default: mode,
					userSelectable: false,
				}),
			).toBe(mode);
		}
		expect(resolvePreference("bad", selectable)).toBe("system");
	});
	test.each([
		["light", true, "light"],
		["dark", false, "dark"],
		["system", true, "dark"],
		["system", false, "light"],
		["invalid", true, "dark"],
		[null, true, "dark"],
	])("pre-paint applies %s with system=%s", (stored, systemDark, expected) => {
		const classes = new Set<string>();
		const element = {
			classList: {
				toggle: (key: string, enabled: boolean) =>
					enabled ? classes.add(key) : classes.delete(key),
			},
			style: { colorScheme: "" },
		};
		runInNewContext(initialColorModeScript(selectable), {
			localStorage: { getItem: () => stored },
			matchMedia: () => ({ matches: systemDark }),
			document: { documentElement: element },
		});
		expect(classes.has("dark")).toBe(expected === "dark");
		expect(element.style.colorScheme).toBe(expected);
	});
	test("blocked storage still honors the default", () => {
		let dark = false;
		runInNewContext(initialColorModeScript(selectable), {
			localStorage: {
				getItem: () => {
					throw new Error("blocked");
				},
			},
			matchMedia: () => ({ matches: true }),
			document: {
				documentElement: {
					classList: {
						toggle: (_key: string, value: boolean) => {
							dark = value;
						},
					},
					style: {},
				},
			},
		});
		expect(dark).toBe(true);
	});
});
