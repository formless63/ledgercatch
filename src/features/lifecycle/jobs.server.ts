import { z } from "zod";

export const trackingRefreshPayload = z.object({
	limit: z.number().int().min(1).max(1000).optional(),
	minIntervalHours: z
		.number()
		.min(1)
		.max(24 * 30)
		.optional(),
	maxAgeDays: z.number().int().min(1).max(3650).optional(),
	ownerId: z.string().optional(),
});

/**
 * Job `tracking.refresh` (schedule e.g. every 6h). Skips gracefully when
 * TRACKING_API_KEY is not configured.
 */
export async function handleTrackingRefresh(
	payload: z.output<typeof trackingRefreshPayload>,
) {
	const { runTrackingRefresh } = await import("./tracking.server");
	return runTrackingRefresh(payload);
}
