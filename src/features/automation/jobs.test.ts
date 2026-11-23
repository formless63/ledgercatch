import { describe, expect, it, vi } from "vitest";

vi.mock("./digest.server", () => ({
	runDueDigests: vi.fn(async () => ({ sent: 0 })),
}));
vi.mock("./budgets.server", () => ({
	ownersWithBudgets: vi.fn(async () => []),
	evaluateBudgetsForOwner: vi.fn(),
}));
vi.mock("./invoice-ninja.server", () => ({
	syncPaidClaims: vi.fn(async () => ({ paid: 0 })),
}));

import { syncPaidClaims } from "./invoice-ninja.server";
import { handleAutomationTick } from "./jobs.server";

describe("scheduled paid-claim sync", () => {
	it("reports the completed claim sweep", async () => {
		expect(await handleAutomationTick()).toMatchObject({ claimsPaid: 0 });
	});
	it("fails the job when sync fails instead of reporting a successful zero", async () => {
		vi.mocked(syncPaidClaims).mockRejectedValueOnce(
			new Error("Synthetic database failure"),
		);
		await expect(handleAutomationTick()).rejects.toThrow(
			"Synthetic database failure",
		);
	});
});
