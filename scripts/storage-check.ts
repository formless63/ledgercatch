import {
	checkStorage,
	getStorage,
} from "../src/integrations/storage/storage.server";
import { storageError } from "../src/integrations/storage/errors.server";
try {
	console.info(await checkStorage());
} catch (error) {
	console.error(storageError(error).toJSON());
	process.exitCode = 1;
} finally {
	try {
		getStorage().close();
	} catch {
		/* Invalid lazy configuration has no client. */
	}
}
