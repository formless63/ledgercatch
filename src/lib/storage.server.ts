// Reference-application wiring only: reusable Storage assets have no OTel import.
import {
	getLogger,
	getMeter,
	withSpan,
} from "../integrations/observability/runtime.server";
import { storageConfig } from "../integrations/storage/config.server";
import {
	createStorage,
	type OperationHook,
	storageOperations,
} from "../integrations/storage/storage.server";

export const observeStorage: OperationHook = async (operation, run) => {
	if (!storageOperations.includes(operation))
		throw new Error("Invalid storage operation");
	const start = performance.now();
	let outcome = "success";
	return withSpan(`storage.${operation}`, async () => {
		try {
			return await run();
		} catch (error) {
			outcome = "failure";
			throw error;
		} finally {
			// Operation is the finite StorageOperation union; results/arguments never enter signals.
			const attributes = {
				"app.storage.operation": operation,
				"app.storage.outcome": outcome,
			};
			const meter = getMeter();
			meter.createCounter("app.storage.operation.count").add(1, attributes);
			meter
				.createHistogram("app.storage.operation.duration", { unit: "s" })
				.record((performance.now() - start) / 1000, attributes);
			getLogger().info(
				{
					operation,
					outcome,
					durationMs: Math.round(performance.now() - start),
				},
				"Storage operation completed",
			);
		}
	});
};
let storage: ReturnType<typeof createStorage> | undefined;
export function getApplicationStorage() {
	storage ??= createStorage(storageConfig(), observeStorage);
	return storage;
}
