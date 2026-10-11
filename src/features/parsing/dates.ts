/**
 * Locale-tolerant absolute date parsing → "YYYY-MM-DD". Relative phrases
 * ("yesterday", "Arriving Friday") are deliberately not supported.
 */

const MONTHS: Record<string, number> = {};
function addMonths(names: string[][]) {
	names.forEach((aliases, index) => {
		for (const alias of aliases) MONTHS[alias] = index + 1;
	});
}
addMonths([
	[
		"jan",
		"january",
		"januar",
		"jänner",
		"janvier",
		"enero",
		"ene",
		"gennaio",
		"gen",
		"janeiro",
		"styczeń",
		"sty",
	],
	[
		"feb",
		"february",
		"februar",
		"février",
		"fév",
		"fev",
		"febrero",
		"febbraio",
		"fevereiro",
		"luty",
		"lut",
	],
	["mar", "march", "märz", "maerz", "mär", "mars", "marzo", "março", "marzec"],
	["apr", "april", "avril", "avr", "abril", "abr", "aprile", "kwiecień", "kwi"],
	["may", "mai", "mayo", "maggio", "mag", "maio", "maj"],
	[
		"jun",
		"june",
		"juni",
		"juin",
		"junio",
		"giugno",
		"giu",
		"junho",
		"czerwiec",
		"cze",
	],
	[
		"jul",
		"july",
		"juli",
		"juillet",
		"juil",
		"julio",
		"luglio",
		"lug",
		"julho",
		"lipiec",
		"lip",
	],
	["aug", "august", "août", "aout", "agosto", "ago", "sierpień", "sie"],
	[
		"sep",
		"sept",
		"september",
		"septembre",
		"septiembre",
		"set",
		"settembre",
		"setembro",
		"wrzesień",
		"wrz",
	],
	[
		"oct",
		"october",
		"oktober",
		"okt",
		"octobre",
		"octubre",
		"ottobre",
		"ott",
		"outubro",
		"out",
		"październik",
		"paź",
	],
	["nov", "november", "novembre", "noviembre", "novembro", "listopad", "lis"],
	[
		"dec",
		"december",
		"dezember",
		"dez",
		"décembre",
		"déc",
		"diciembre",
		"dic",
		"dicembre",
		"dezembro",
		"grudzień",
		"gru",
	],
]);

function monthFromName(name: string): number | undefined {
	const key = name.toLowerCase().replace(/\.$/, "");
	return MONTHS[key];
}

function normalizeYear(year: string): number {
	const n = Number(year);
	return year.length <= 2 ? 2000 + n : n;
}

function iso(year: number, month: number, day: number): string | undefined {
	if (!Number.isInteger(year) || year < 1990 || year > 2100) return undefined;
	if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
		return undefined;
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type ParseDateOptions = {
	/** For ambiguous "03/10/2026": true = day first (EU), false = month first (US). */
	dayFirst?: boolean;
};

const WORD = "([A-Za-zÀ-ÿżźćńółęąśŻŹĆŃÓŁĘĄŚ]{3,12}\\.?)";

/**
 * Parses an absolute date from text, returning ISO YYYY-MM-DD or undefined.
 * Accepts epoch milliseconds/seconds as numbers too.
 */
export function parseDate(
	input: string | number | null | undefined,
	options: ParseDateOptions = {},
): string | undefined {
	if (input === null || input === undefined) return undefined;
	if (typeof input === "number") {
		if (!Number.isFinite(input) || input <= 0) return undefined;
		const ms = input < 1e11 ? input * 1000 : input;
		const d = new Date(ms);
		return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
	}
	const text = String(input).replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	if (/^\d{10,13}$/.test(text)) return parseDate(Number(text));

	let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})(?:\b|T)/.exec(text);
	if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

	m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
	if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

	m = /\b(\d{4})[/.](\d{1,2})[/.](\d{1,2})\b/.exec(text);
	if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

	// "October 3, 2026", "Oct. 03 2026", "Mar 14, 2021 at 3:17 PM"
	m = new RegExp(`${WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`).exec(
		text,
	);
	if (m) {
		const month = monthFromName(m[1] ?? "");
		if (month) {
			const r = iso(Number(m[3]), month, Number(m[2]));
			if (r) return r;
		}
	}

	// "3 Oct 2026", "14. März 2026", "3rd October, 2026", "3 de octubre de 2026"
	m = new RegExp(
		`\\b(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:de\\s+)?${WORD},?\\s+(?:de\\s+)?(\\d{4})\\b`,
	).exec(text);
	if (m) {
		const month = monthFromName(m[2] ?? "");
		if (month) {
			const r = iso(Number(m[3]), month, Number(m[1]));
			if (r) return r;
		}
	}

	// "14-Mar-26", "14-Mar-2026", "14 Mar 26"
	m = new RegExp(`\\b(\\d{1,2})[-\\s]${WORD}[-\\s](\\d{2}|\\d{4})\\b`).exec(
		text,
	);
	if (m) {
		const month = monthFromName(m[2] ?? "");
		if (month) {
			const r = iso(normalizeYear(m[3] ?? ""), month, Number(m[1]));
			if (r) return r;
		}
	}

	// "03.10.2026" (de: day.month.year)
	m = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/.exec(text);
	if (m) return iso(normalizeYear(m[3] ?? ""), Number(m[2]), Number(m[1]));

	// "10/03/2026" or "03-10-2026": US month-first unless dayFirst or impossible.
	m = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/.exec(text);
	if (m) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		const year = normalizeYear(m[3] ?? "");
		const dayFirst = options.dayFirst ?? false;
		if (a > 12) return iso(year, b, a);
		if (b > 12) return iso(year, a, b);
		return dayFirst ? iso(year, b, a) : iso(year, a, b);
	}
	return undefined;
}
