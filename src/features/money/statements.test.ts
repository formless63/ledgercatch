import { describe, expect, it } from "vitest";
import {
	detectSignConvention,
	detectStatementPreset,
	parseOfx,
	parseQif,
	parseStatementRows,
	qifDate,
	transactionIdentities,
} from "./statements";

const csv = (text: string) => {
	const [header = "", ...rows] = text.trim().split("\n");
	return {
		headers: header.split(","),
		data: rows.map((row) => row.split(",")),
	};
};

describe("CSV presets", () => {
	it("Chase card: charges negative → positive, payments classified", () => {
		const { headers, data } =
			csv(`Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/01/2026,10/02/2026,AMZN Mktp US*2K4AB12C3,Shopping,Sale,-46.97,
10/03/2026,10/03/2026,Payment Thank You-Mobile,,Payment,500.00,
10/04/2026,10/05/2026,AMAZON.COM REFUND,Shopping,Return,12.50,`);
		const result = parseStatementRows(headers, data);
		expect(result.presetId).toBe("chase_card");
		expect(result.rows.map((r) => [r.date, r.amountMinor, r.kind])).toEqual([
			["2026-10-01", 4697, "charge"],
			["2026-10-03", -50000, "payment"],
			["2026-10-04", -1250, "credit"],
		]);
	});

	it("Amex: charges positive", () => {
		const { headers, data } = csv(`Date,Description,Card Member,Account #,Amount
10/03/2026,DIGIKEY ELECTRONICS,JANE DOE,-41005,123.45
10/04/2026,MOUSER ELECTRONICS CREDIT,JANE DOE,-41005,-10.00`);
		const result = parseStatementRows(headers, data);
		expect(result.presetId).toBe("amex");
		expect(result.rows.map((r) => r.amountMinor)).toEqual([12345, -1000]);
		expect(result.rows[1]?.kind).toBe("credit");
	});

	it("Capital One debit/credit columns and card number", () => {
		const { headers, data } =
			csv(`Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-10-01,2026-10-02,1234,ALIEXPRESS.COM,Merchandise,19.99,
2026-10-05,2026-10-05,1234,CAPITAL ONE AUTOPAY PYMT,Payment/Credit,,250.00`);
		const result = parseStatementRows(headers, data);
		expect(result.presetId).toBe("capital_one");
		expect(result.accountHint).toBe("1234");
		expect(result.rows.map((r) => [r.amountMinor, r.kind])).toEqual([
			[1999, "charge"],
			[-25000, "payment"],
		]);
	});

	it("Citi negative credits in the credit column", () => {
		const { headers, data } = csv(`Status,Date,Description,Debit,Credit
Cleared,10/02/2026,EBAY O*12-34567-89012,55.00,
Cleared,10/09/2026,EBAY RETURN,,-55.00`);
		const result = parseStatementRows(headers, data);
		expect(result.presetId).toBe("citi");
		expect(result.rows.map((r) => r.amountMinor)).toEqual([5500, -5500]);
	});

	it("Discover and Apple Card", () => {
		const discover = csv(`Trans. Date,Post Date,Description,Amount,Category
10/02/2026,10/03/2026,MOUSER ELECTRONICS,88.10,Merchandise`);
		expect(parseStatementRows(discover.headers, discover.data).presetId).toBe(
			"discover",
		);
		const apple =
			csv(`Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
10/02/2026,10/03/2026,AMAZON MKTPL*AB12,Amazon,Other,Purchase,30.00,Jane`);
		const result = parseStatementRows(apple.headers, apple.data);
		expect(result.presetId).toBe("apple_card");
		expect(result.rows[0]).toMatchObject({
			description: "Amazon",
			amountMinor: 3000,
		});
	});

	it("PayPal: skips conversions, currency per row", () => {
		const { headers, data } =
			csv(`Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID
10/02/2026,10:00:00,PDT,Some Shop,Express Checkout Payment,Completed,EUR,-46.97,0.00,-46.97,1AB
10/02/2026,10:00:00,PDT,,General Currency Conversion,Completed,EUR,46.97,0.00,46.97,2AB`);
		const result = parseStatementRows(headers, data);
		expect(result.presetId).toBe("paypal");
		expect(result.skipped).toBe(1);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({
			amountMinor: 4697,
			currency: "EUR",
			externalId: "1AB",
		});
	});

	it("generic layout detects the sign convention and can be overridden", () => {
		const { headers, data } = csv(`Date,Payee,Amount
2026-10-01,Shop A,-10.00
2026-10-02,Shop B,-20.00
2026-10-03,Refund,5.00`);
		expect(detectStatementPreset(headers).id).toBe("generic");
		const auto = parseStatementRows(headers, data);
		expect(auto.signConvention).toBe("charges_negative");
		expect(auto.rows.map((r) => r.amountMinor)).toEqual([1000, 2000, -500]);
		const forced = parseStatementRows(headers, data, {
			signConvention: "charges_positive",
		});
		expect(forced.rows.map((r) => r.amountMinor)).toEqual([-1000, -2000, 500]);
		expect(detectSignConvention([1, 2, -3])).toBe("charges_positive");
	});

	it("reports unreadable rows", () => {
		const { headers, data } = csv(`Date,Description,Amount
banana,Shop,1.00`);
		expect(parseStatementRows(headers, data).errors[0]?.message).toMatch(
			/date/i,
		);
	});
});

describe("OFX / QFX", () => {
	it("parses SGML OFX v1 credit card statements", () => {
		const text = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD
<CCACCTFROM><ACCTID>4111111111111234</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003120000.000[-5:EST]<TRNAMT>-46.97<FITID>2026100301<NAME>AMZN Mktp US*2K4 &amp; CO</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261010<TRNAMT>12.00<FITID>2026101002<NAME>DIGIKEY<MEMO>REFUND</STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT<DTPOSTED>20261011<TRNAMT>300.00<FITID>2026101103<NAME>PAYMENT</STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
		const result = parseOfx(text);
		expect(result.accountHint).toBe("1234");
		expect(
			result.rows.map((r) => [r.date, r.amountMinor, r.kind, r.externalId]),
		).toEqual([
			["2026-10-03", 4697, "charge", "2026100301"],
			["2026-10-10", -1200, "credit", "2026101002"],
			["2026-10-11", -30000, "payment", "2026101103"],
		]);
		expect(result.rows[0]?.description).toBe("AMZN Mktp US*2K4 & CO");
	});

	it("parses XML OFX v2 with closing tags and EUR", () => {
		const text = `<?xml version="1.0"?><?OFX OFXHEADER="200"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR</CURDEF>
<BANKACCTFROM><ACCTID>DE89370400440532013000</ACCTID></BANKACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>POS</TRNTYPE><DTPOSTED>20261003</DTPOSTED><DTUSER>20261002</DTUSER><TRNAMT>-1234.50</TRNAMT><FITID>X1</FITID><NAME>Reichelt</NAME></STMTTRN></BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
		const result = parseOfx(text);
		expect(result.currency).toBe("EUR");
		expect(result.rows[0]).toMatchObject({
			date: "2026-10-02",
			amountMinor: 123450,
			currency: "EUR",
		});
	});
});

describe("QIF", () => {
	it("parses card records with various date styles", () => {
		const text = `!Type:CCard
D10/03'26
T-46.97
PAMAZON.COM
^
D10/ 4/2026
T12.00
PMOUSER REFUND
MReturn
^
`;
		const result = parseQif(text);
		expect(result.rows.map((r) => [r.date, r.amountMinor, r.kind])).toEqual([
			["2026-10-03", 4697, "charge"],
			["2026-10-04", -1200, "credit"],
		]);
	});
	it("handles day-first dates and skips account headers", () => {
		expect(qifDate("3.10.2026")).toBe("2026-10-03");
		expect(qifDate("03/10/26", true)).toBe("2026-10-03");
		const result = parseQif(`!Account
NVisa 9876
TCCard
^
!Type:Bank
D2026-10-05
T-1,234.56
PRENT
^`);
		expect(result.accountHint).toBe("9876");
		expect(result.rows[0]?.amountMinor).toBe(123456);
	});
});

describe("identities", () => {
	it("keeps identical same-day rows distinct but stable across re-imports", () => {
		const row = {
			date: "2026-10-01",
			description: "COFFEE",
			amountMinor: 450,
			currency: "USD",
			kind: "charge" as const,
			raw: {},
		};
		const ids = transactionIdentities([row, row], "card");
		expect(ids[0]).not.toBe(ids[1]);
		expect(transactionIdentities([row, row], "card")).toEqual(ids);
		expect(
			transactionIdentities([{ ...row, externalId: "F1" }], "card")[0],
		).toBe("id|card|F1");
	});
});
