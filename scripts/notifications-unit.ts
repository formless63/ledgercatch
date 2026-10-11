import vectors from "../fixtures/notifications-contract.json";
import assert from "node:assert/strict";
import { queryNotifications, notificationValues, decodeNotificationCursor, encodeNotificationCursor } from "../src/integrations/notifications/notifications.server";
import { notificationDeliveryPayload, createNotificationJobs } from "../src/integrations/notifications/jobs.server";
import { validateNotificationMetadata } from "../src/integrations/notifications/validation";
import { ntfyConfig } from "../src/integrations/notifications/ntfy.server";
const input = { recipientId: "fixture", type: "fixture.created", title: "Fixture", body: "Plain text" };
const row = notificationValues(input); assert.equal(row.readAt, null); assert.deepEqual(row.metadata, {});
assert.throws(() => notificationValues({ ...input, id: row.id } as typeof input)); assert.throws(() => validateNotificationMetadata({ access_token: "private" }));
assert.throws(() => notificationValues({ ...input, body: "🦀".repeat(1025) })); assert.throws(() => notificationValues({ ...input, body: "<b>html</b>" }));
assert.equal(decodeNotificationCursor(encodeNotificationCursor(row)).id, row.id);
assert.throws(() => notificationDeliveryPayload.parse({ notificationId: row.id, channel: "email", email: "private" }));
assert.throws(() => ntfyConfig({})); assert.equal(ntfyConfig({ NODE_ENV: "test", NTFY_BASE_URL: "http://127.0.0.1:8080" }).timeoutSeconds, 10);
const jobs = createNotificationJobs({ load: async () => row, adapters: {} }); assert.equal(jobs["notifications.deliver"].queue.retryLimit, 5);
assert.deepEqual(await jobs["notifications.deliver"].handler({ notificationId: row.id, channel: "email" }), { outcome: "permanent", category: "disabled" });
console.info("Backendless Notifications contracts verified without Email, Realtime, Audit or ntfy");

const executor = {select: () => ({from: () => ({where: () => ({orderBy: () => ({limit: async () => []})})})})} as unknown as Parameters<typeof queryNotifications>[0];
for(const type of vectors.types.accepted) {assert.equal(notificationValues({...input,type}).type,type);await queryNotifications(executor,input.recipientId,{type});}
await queryNotifications(executor,input.recipientId,{type:undefined});
for(const type of vectors.types.rejected) {assert.throws(() => notificationValues({...input,type}));await assert.rejects(queryNotifications(executor,input.recipientId,{type}));}
for(const title of vectors.titles.accepted) assert.equal(notificationValues({...input,title}).title,title);
for(const title of vectors.titles.rejected) assert.throws(() => notificationValues({...input,title}));
for(const key of vectors.metadataKeys.accepted) assert.deepEqual(validateNotificationMetadata({[key]:1}),{[key]:1});
for(const key of vectors.metadataKeys.rejected) assert.throws(() => validateNotificationMetadata({[key]:1}));
console.info("Shared create/list type, exact title and whitespace metadata-key regression vectors passed");
