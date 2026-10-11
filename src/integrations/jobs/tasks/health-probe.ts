import { z } from "zod";

export const healthProbePayload = z.object({
	message: z.string().trim().min(1).max(1_000),
});

export async function handleHealthProbe(
	payload: z.output<typeof healthProbePayload>,
) {
	return { echoed: payload.message };
}
