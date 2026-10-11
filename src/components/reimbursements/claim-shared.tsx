import { IconCheck, IconX } from "@tabler/icons-react";
import type { Tone } from "#/components/app/format";
import { Button } from "#/components/app/primitives";

export type ClaimStatus = "draft" | "submitted" | "paid" | "void";

export const CLAIM_TONES: Record<string, Tone> = {
	draft: "neutral",
	submitted: "info",
	paid: "success",
	void: "neutral",
};

export function ClaimActions({
	status,
	disabled,
	onStatus,
}: {
	status: string;
	disabled?: boolean;
	onStatus: (status: ClaimStatus) => void;
}) {
	return (
		<span className="inline-flex gap-1">
			{(status === "draft" || status === "submitted") && (
				<Button size="xs" disabled={disabled} onClick={() => onStatus("paid")}>
					<IconCheck />
					Mark paid
				</Button>
			)}
			{status === "paid" && (
				<Button
					size="xs"
					variant="ghost"
					disabled={disabled}
					onClick={() => onStatus("submitted")}
				>
					Reopen
				</Button>
			)}
			{status !== "void" && status !== "paid" && (
				<Button
					size="xs"
					variant="ghost"
					disabled={disabled}
					title="Void the claim and return its orders to unclaimed"
					onClick={() => {
						if (
							window.confirm(
								"Void this claim? Its orders return to the unclaimed list.",
							)
						)
							onStatus("void");
					}}
				>
					<IconX />
					Void
				</Button>
			)}
		</span>
	);
}
