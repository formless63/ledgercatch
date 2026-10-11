import { browser } from "wxt/browser";
import { mouserInvoiceOrders } from "@/lib/mouser-invoices";
import { serialized } from "./history";

const KEY = "mouserInvoiceOrders";
const MAX_ENTRIES = 2000;

export async function rememberMouserInvoiceOrders(body: unknown): Promise<void> {
	const found = mouserInvoiceOrders(body);
	if (!Object.keys(found).length) return;
	await serialized(async () => {
		const old = (await browser.storage.local.get(KEY))[KEY] as Record<string, string> | undefined;
		await browser.storage.local.set({
			[KEY]: Object.fromEntries(Object.entries({ ...old, ...found }).slice(-MAX_ENTRIES)),
		});
	});
}

export async function orderForMouserInvoice(number: string): Promise<string | undefined> {
	const map = (await browser.storage.local.get(KEY))[KEY] as Record<string, string> | undefined;
	return map?.[number];
}

export async function clearMouserInvoiceOrders(): Promise<void> {
	await browser.storage.local.remove(KEY);
}
