const definitions = {
	invalid_input: [400, "Invalid input.", false],
	unauthenticated: [401, "Authentication required.", false],
	forbidden: [403, "Access denied.", false],
	not_found: [404, "Resource not found.", false],
	conflict: [409, "Operation conflict.", false],
	limit_exceeded: [413, "Limit exceeded.", false],
	unsupported: [422, "Operation unsupported.", false],
	unconfigured: [503, "Integration is not configured.", false],
	unavailable: [503, "Integration unavailable.", true],
	deadline_exceeded: [504, "Operation deadline exceeded.", true],
	cancelled: [409, "Operation cancelled.", false],
} as const;
export type ErrorCode = keyof typeof definitions;
export class InvoiceNinjaError extends Error {
	constructor(readonly code: ErrorCode) {
		super(definitions[code][1]);
	}
	get status() {
		return definitions[this.code][0];
	}
	public(read = true) {
		return {
			code: this.code,
			message: this.message,
			retryable: read && definitions[this.code][2],
		};
	}
}
