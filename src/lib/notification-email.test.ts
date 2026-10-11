import { expect, it, vi } from "vitest";
import { EmailError } from "../integrations/email/errors.server";
import { notificationValues } from "../integrations/notifications/notifications.server";
import { notificationEmailAdapter } from "./notification-email.server";

it("resolves current target and delegates exactly once to Email, retaining partial and ambiguous outcomes", async () => {
	const row = notificationValues({
		recipientId: "stable-id",
		type: "fixture.created",
		title: "Title",
		body: "Private",
	});
	const sendEmail = vi
		.fn()
		.mockResolvedValue({ outcome: "accepted", accepted: 1, rejected: 0 });
	const resolveEmail = vi.fn().mockResolvedValue("current@example.test"),
		context = { signal: new AbortController().signal };
	const adapter = notificationEmailAdapter({
		resolveEmail,
		email: () => ({ sendEmail }),
	});
	expect(await adapter(row, context)).toEqual({ outcome: "delivered" });
	expect(resolveEmail).toHaveBeenCalledWith(row.recipientId, context.signal);
	expect(sendEmail).toHaveBeenCalledWith({
		to: [{ address: "current@example.test" }],
		subject: row.title,
		text: row.body,
	});
	expect(sendEmail).toHaveBeenCalledTimes(1);
	sendEmail.mockResolvedValueOnce({ outcome: "partial" });
	expect(await adapter(row, context)).toEqual({ outcome: "partial" });
	sendEmail.mockRejectedValueOnce(new EmailError("timeout", false));
	expect(await adapter(row, context)).toEqual({ outcome: "ambiguous" });
	expect(sendEmail).toHaveBeenCalledTimes(3);
	sendEmail.mockRejectedValueOnce(new EmailError("temporary-rejection", true));
	await expect(adapter(row, context)).rejects.toMatchObject({
		retryable: true,
	});
	expect(sendEmail).toHaveBeenCalledTimes(4);
});
