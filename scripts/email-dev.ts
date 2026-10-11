import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

export function docker(args: string[], environment: NodeJS.ProcessEnv = {}) {
	const result = spawnSync("docker", args, { stdio: "inherit", env: { ...process.env, ...environment } });
	if (result.status !== 0) throw new Error("Email development container command failed");
}
export async function freePort() {
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No fixture port");
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return address.port;
}
export function fixtureEnvironment(smtp: number, ui: number): NodeJS.ProcessEnv {
	return { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp), SMTP_SECURITY: "opportunistic", SMTP_USER: "", SMTP_PASSWORD: "", EMAIL_FROM_ADDRESS: "starter@example.test", EMAIL_FROM_NAME: "Starter", EMAIL_REPLY_TO_ADDRESS: "reply@example.test", EMAIL_REPLY_TO_NAME: "Replies", EMAIL_MAX_RECIPIENTS: "50", MAILPIT_API_URL: `http://127.0.0.1:${ui}` };
}
export async function waitForMailpit(url: string) {
	for (let i = 0; i < 60; i++) {
		try { if ((await fetch(`${url}/api/v1/messages`)).ok) return; } catch { /* Disposable service starting. */ }
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error("Disposable Mailpit did not become ready");
}
if (import.meta.main) {
	const action = process.argv[2];
	if (action !== "up" && action !== "down") throw new Error("Choose up or down");
	docker(["compose", "-f", "compose.email.yaml", ...(action === "up" ? ["up", "-d", "mailpit"] : ["down"])]);
}
