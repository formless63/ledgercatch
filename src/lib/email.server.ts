// Application-owned integration. Reusable Email has no Observability dependency.

import {
	createEmail,
	type EmailOperationHook,
} from "../integrations/email/email.server";
import {
	getLogger,
	getMeter,
	withSpan,
} from "../integrations/observability/runtime.server";

export const observeEmail: EmailOperationHook = async (operation, work) => {
	if (
		!["send", "verify"].includes(operation.operation) ||
		!["tls", "starttls", "opportunistic"].includes(operation.security) ||
		!Number.isInteger(operation.recipientCount) ||
		operation.recipientCount < 0 ||
		operation.recipientCount > 100
	)
		throw new Error("Invalid email operation metadata");
	const start = performance.now();
	let outcome: "accepted" | "partial" | "success" | "failure" = "success";
	return withSpan(`email.${operation.operation}`, async () => {
		try {
			const result = await work();
			if (
				result &&
				typeof result === "object" &&
				"outcome" in result &&
				(result.outcome === "accepted" || result.outcome === "partial")
			)
				outcome = result.outcome;
			return result;
		} catch (error) {
			outcome = "failure";
			throw error;
		} finally {
			const attributes = {
				"app.email.operation": operation.operation,
				"app.email.outcome": outcome,
				"app.email.security": operation.security,
			};
			const meter = getMeter();
			meter.createCounter("app.email.operation.count").add(1, attributes);
			meter
				.createHistogram("app.email.operation.duration", { unit: "s" })
				.record((performance.now() - start) / 1000, attributes);
			meter
				.createHistogram("app.email.recipient.count")
				.record(operation.recipientCount, attributes);
			getLogger().info(
				{
					operation: operation.operation,
					outcome,
					security: operation.security,
					recipientCount: operation.recipientCount,
					durationMs: Math.round(performance.now() - start),
				},
				"Email operation completed",
			);
		}
	});
};
let email: ReturnType<typeof createEmail> | undefined;
export function getApplicationEmail() {
	email ??= createEmail(undefined, observeEmail);
	return email;
}
export function closeApplicationEmail() {
	email?.close();
	email = undefined;
}
process.once("beforeExit", closeApplicationEmail);
