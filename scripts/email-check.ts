import { closeEmail, emailError, verifyEmailTransport } from "../src/integrations/email/email.server";
try { await verifyEmailTransport(); console.info("Email transport verified; no message sent"); }
catch (error) { console.error(emailError(error).toJSON()); process.exitCode = 1; }
finally { closeEmail(); }
