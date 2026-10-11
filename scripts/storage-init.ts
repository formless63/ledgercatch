// Deployment helper: create the configured bucket if it does not exist.
// Idempotent; run as a one-shot service before the app starts. No CORS is
// configured because documents are proxied through the app, never presigned.
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { storageConfig } from "../src/integrations/storage/config.server";
import { storageError } from "../src/integrations/storage/errors.server";
import { getStorage } from "../src/integrations/storage/storage.server";

const storage = getStorage();
const config = storageConfig();
for (let attempt = 1; ; attempt++) {
	try {
		await storage.checkStorage();
		console.log(`Bucket ${config.bucket} ready`);
		break;
	} catch (error) {
		const code = storageError(error).code;
		if (code === "not_found") {
			await storage.getS3Client().send(new CreateBucketCommand({ Bucket: config.bucket }));
			console.log(`Created bucket ${config.bucket}`);
			continue;
		}
		if (attempt >= 30) throw error;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}
storage.close();
