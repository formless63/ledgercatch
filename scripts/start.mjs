const developmentSecret = "development-only-secret-change-me-now";
const errors = [];

if (!process.env.DATABASE_URL) {
	errors.push("DATABASE_URL is required");
} else {
	try {
		const database = new URL(process.env.DATABASE_URL);
		if (!["postgres:", "postgresql:"].includes(database.protocol)) {
			errors.push("DATABASE_URL must use PostgreSQL");
		}
		if (
			process.env.DATABASE_URL ===
			"postgresql://starter:starter@localhost:5432/starter"
		) {
			errors.push("DATABASE_URL must not use the development default");
		}
	} catch {
		errors.push("DATABASE_URL must be a valid URL");
	}
}
if (!process.env.BETTER_AUTH_SECRET) {
	errors.push("BETTER_AUTH_SECRET is required");
} else if (
	process.env.BETTER_AUTH_SECRET.length < 32 ||
	process.env.BETTER_AUTH_SECRET === developmentSecret
) {
	errors.push("BETTER_AUTH_SECRET must be 32+ characters and non-default");
}
if (!process.env.APP_BASE_URL) {
	errors.push("APP_BASE_URL is required");
} else {
	try {
		if (new URL(process.env.APP_BASE_URL).hostname === "localhost") {
			errors.push("APP_BASE_URL must not use localhost");
		}
	} catch {
		errors.push("APP_BASE_URL must be a valid URL");
	}
}

if (errors.length > 0) {
	console.error(`Invalid production environment:\n- ${errors.join("\n- ")}`);
	process.exit(1);
}

await import("../.output/server/index.mjs");
