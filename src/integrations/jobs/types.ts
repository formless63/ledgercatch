import type { z } from "zod";

/** Native pg-boss attempt metadata. An abort alone does not identify a terminal failure. */
export interface JobHandlerContext {
	id: string;
	signal: AbortSignal;
	retryCount: number;
	retryLimit?: number;
}

export interface JobDefinition<TSchema extends z.ZodType> {
	payload: TSchema;
	queue: {
		deleteAfterSeconds: number;
		expireInSeconds: number;
		retryDelay: number;
		retryLimit: number;
		retryBackoff?: boolean;
		retryDelayMax?: number;
	};
	handler: (
		payload: z.output<TSchema>,
		context?: JobHandlerContext,
	) => Promise<object>;
}

export type JobDefinitions = Record<string, JobDefinition<z.ZodType>>;

export function defineJob<TSchema extends z.ZodType>(
	definition: JobDefinition<TSchema>,
) {
	return definition;
}
