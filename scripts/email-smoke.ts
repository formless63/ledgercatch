import { randomUUID } from "node:crypto";
import { closeEmail, emailError, sendEmail } from "../src/integrations/email/email.server";
try {
	if (!process.env.EMAIL_SMOKE_TO) throw new Error("Explicit recipient required");
	const result = await sendEmail({ to: [{ address: process.env.EMAIL_SMOKE_TO }], subject: `Email smoke ${randomUUID()}`, text: "A single transactional SMTP smoke message.", html: "<p>A single transactional SMTP smoke message.</p>" });
	console.info(`Email smoke completed: ${result.outcome}`);
} catch (error) { console.error(emailError(error).toJSON()); process.exitCode = 1; }
finally { closeEmail(); }
