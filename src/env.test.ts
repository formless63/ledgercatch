import { describe, expect, it } from "vitest";
import { z } from "zod";
import { serverSchemaFor } from "./env";

describe("production environment validation", () => {
	it("requires explicit database, auth secret, and application URL values", () => {
		const schema = z.object(serverSchemaFor("production"));
		const result = schema.safeParse({ NODE_ENV: "production" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.flatten().fieldErrors).toMatchObject({
				DATABASE_URL: expect.any(Array),
				BETTER_AUTH_SECRET: expect.any(Array),
				APP_BASE_URL: expect.any(Array),
			});
		}
	});

	it("rejects development defaults in production", () => {
		const schema = z.object(serverSchemaFor("production"));
		const result = schema.safeParse({
			NODE_ENV: "production",
			DATABASE_URL: "postgresql://starter:starter@localhost:5432/starter",
			BETTER_AUTH_SECRET: "development-only-secret-change-me-now",
			APP_BASE_URL: "http://localhost:3000",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(Object.keys(result.error.flatten().fieldErrors)).toEqual([
				"DATABASE_URL",
				"BETTER_AUTH_SECRET",
				"APP_BASE_URL",
			]);
		}
	});
});
