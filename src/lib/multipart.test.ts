import { describe, expect, it } from "vitest";
import { readMultipart } from "./multipart.server";

async function request(form: FormData, declared?: string) {
	const source = new Request("http://localhost/upload", {
		method: "POST",
		body: form,
	});
	const headers = new Headers(source.headers);
	if (declared) headers.set("content-length", declared);
	return new Request(source.url, {
		method: "POST",
		headers,
		body: await source.arrayBuffer(),
		duplex: "half",
	} as RequestInit);
}
describe("streamed multipart bounds", () => {
	it("accepts an ordinary bounded body without content-length", async () => {
		const f = new FormData();
		f.set("file", new Blob(["synthetic"]), "invoice.txt");
		expect(
			(await readMultipart(await request(f), 1024)).get("file"),
		).toBeInstanceOf(Blob);
	});
	it("rejects actual oversized bytes even with a false length", async () => {
		const f = new FormData();
		f.set("file", new Blob(["x".repeat(3000)]), "invoice.txt");
		await expect(
			readMultipart(await request(f, "1"), 1024),
		).rejects.toMatchObject({ status: 413 });
	});
	it("rejects oversized non-file fields", async () => {
		const f = new FormData();
		f.set("meta", "x".repeat(65537));
		await expect(readMultipart(await request(f), 100000)).rejects.toMatchObject(
			{ status: 413 },
		);
	});
});
