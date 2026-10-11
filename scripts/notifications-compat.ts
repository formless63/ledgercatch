import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { publishNtfy, ntfyConfig } from "../src/integrations/notifications/ntfy.server";
import { notificationValues } from "../src/integrations/notifications/notifications.server";
const name = `notifications-ntfy-${randomUUID()}`;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  docker("run", "-d", "--name", name, "-p", "127.0.0.1::80", "binwiederhier/ntfy:v2.28.0", "serve", "--listen-http", ":80", "--cache-file", "/tmp/ntfy.db");
  const port = docker("port", name, "80/tcp").split(":").at(-1), base = `http://127.0.0.1:${port}`;
  let ready = false; for (let i=0;i<100;i++) { try { ready = (await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r,100)); }
  assert.ok(ready, "Disposable ntfy must become healthy");
  const notification = notificationValues({ recipientId: "fixture", type: "fixture.created", title: "Fixture title", body: "Protocol-level notification" });
  assert.deepEqual(await publishNtfy(notification, "fixture", { config: ntfyConfig({ NODE_ENV: "test", NTFY_BASE_URL: base }) }), { outcome: "delivered" });
  // Only the test subscriber reads the official subscription response; delivery primitive never reads publish response bodies.
  const events = (await (await fetch(`${base}/fixture/json?poll=1`)).text()).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.event === "message" && event.title === notification.title && event.message === notification.body));
  console.info("Official pinned ntfy v2.28.0 JSON publish/subscription verified on disposable localhost; no public service contacted");
} finally { try { docker("rm", "-f", name); } catch {} }
