export interface AiInput {
	messages: { role: "system" | "user" | "assistant"; content: string }[];
	temperature?: number;
	maxOutputTokens?: number;
	signal?: AbortSignal;
}
export type AiFinishReason = "stop" | "length" | "content-filter" | "other";
export interface AiUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}
export interface AiTextResult {
	text: string;
	finishReason: AiFinishReason;
	usage?: AiUsage;
}
export type AiStreamEvent =
	| { type: "text-delta"; text: string }
	| { type: "finish"; finishReason: AiFinishReason; usage?: AiUsage };
