import { auth } from "#/lib/auth";
import {
	type ApiPermissionRequirement,
	type ApiPermissions,
	apiPermissionsSchema,
	hasRequiredPermissions,
} from "./permissions";
import { ApiHttpError } from "./responses";

export type ApiPrincipal = {
	type: "user";
	userId: string;
	keyId: string;
	permissions: ApiPermissions;
};

export async function requireApiKey(
	request: Request,
	required: ApiPermissionRequirement,
): Promise<ApiPrincipal> {
	const rawKey = request.headers.get("x-api-key")?.trim();
	if (!rawKey) {
		throw new ApiHttpError(
			401,
			"unauthorized",
			"A valid X-API-Key header is required.",
		);
	}

	const result = await auth.api.verifyApiKey({ body: { key: rawKey } });
	if (!result.valid || !result.key) {
		if (result.error?.code === "RATE_LIMITED") {
			throw new ApiHttpError(
				429,
				"rate_limited",
				"The API key rate limit was exceeded.",
			);
		}
		throw new ApiHttpError(
			401,
			"unauthorized",
			"The API key is invalid or inactive.",
		);
	}

	const parsedPermissions = apiPermissionsSchema.safeParse(
		result.key.permissions ?? {},
	);
	const permissions = parsedPermissions.success
		? parsedPermissions.data
		: apiPermissionsSchema.parse({});
	if (!hasRequiredPermissions(permissions, required)) {
		throw new ApiHttpError(
			403,
			"forbidden",
			"The API key lacks the required permission.",
		);
	}

	return {
		type: "user",
		userId: result.key.referenceId,
		keyId: result.key.id,
		permissions,
	};
}
