import { expect, test } from "@playwright/test";

for (const preference of ["light", "dark", "system"] as const) {
	test(`persisted ${preference}, selector, and system preference changes`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (message) => {
			if (
				message.type() === "error" &&
				/hydration|hydrated|mismatch/i.test(message.text())
			)
				errors.push(message.text());
		});
		await page.emulateMedia({ colorScheme: "dark" });
		await page.addInitScript(
			(value) => localStorage.setItem("theme", value),
			preference,
		);
		await page.goto("/");
		const selector = page.getByRole("combobox", { name: "Color mode" });
		// A cold Vite dependency build can outlast the default assertion timeout.
		// Readiness is explicit: SSR disables selection until hydration attaches handlers.
		await expect(selector).toBeEnabled({ timeout: 15_000 });
		await expect(selector).toHaveValue(preference);
		await expect(page.locator("html")).toHaveClass(
			preference === "light" ? "" : /dark/,
		);
		await page.emulateMedia({ colorScheme: "light" });
		if (preference === "dark")
			await expect(page.locator("html")).toHaveClass(/dark/);
		else await expect(page.locator("html")).not.toHaveClass(/dark/);
		await selector.selectOption("dark");
		await expect(page.locator("html")).toHaveClass(/dark/);
		expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe(
			"dark",
		);
		await selector.selectOption("system");
		await page.emulateMedia({ colorScheme: "dark" });
		await expect(page.locator("html")).toHaveClass(/dark/);
		await selector.selectOption("light");
		await expect(page.locator("html")).not.toHaveClass(/dark/);
		expect(errors).toEqual([]);
	});
}

test("selection persists through reload and cross-tab updates", async ({
	page,
	context,
}) => {
	await page.goto("/");
	const selector = page.getByRole("combobox", { name: "Color mode" });
	await selector.selectOption("dark");
	await page.reload();
	await expect(selector).toHaveValue("dark");
	await expect(page.locator("html")).toHaveClass(/dark/);
	const second = await context.newPage();
	await second.goto("/");
	await second
		.getByRole("combobox", { name: "Color mode" })
		.selectOption("light");
	await expect(selector).toHaveValue("light");
	await expect(page.locator("html")).not.toHaveClass(/dark/);
	await second.close();
});

test("head script applies before the application JavaScript loads", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.addInitScript(() => localStorage.setItem("theme", "dark"));
	await page.route("**/*", (route) =>
		route.request().resourceType() === "script"
			? route.abort()
			: route.continue(),
	);
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.locator("html")).toHaveClass(/dark/);
	expect(
		await page
			.locator("html")
			.evaluate((element) => getComputedStyle(element).colorScheme),
	).toBe("dark");
	expect(
		await page
			.locator("body")
			.evaluate((element) => getComputedStyle(element).backgroundColor),
	).not.toBe("rgba(0, 0, 0, 0)");
});

test("storage denial retains an in-tab choice and follows system", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.addInitScript(() => {
		Storage.prototype.getItem = () => {
			throw new Error("blocked fixture");
		};
		Storage.prototype.setItem = () => {
			throw new Error("blocked fixture");
		};
	});
	await page.goto("/");
	await expect(page.locator("html")).toHaveClass(/dark/);
	const selector = page.getByRole("combobox", { name: "Color mode" });
	await selector.selectOption("light");
	await expect(page.locator("html")).not.toHaveClass(/dark/);
	await selector.selectOption("system");
	await page.emulateMedia({ colorScheme: "light" });
	await expect(page.locator("html")).not.toHaveClass(/dark/);
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveClass(/dark/);
});
