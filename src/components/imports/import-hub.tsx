/** Import hub: every way orders get into the ledger besides passive capture. */
import {
	IconApi,
	IconArchive,
	IconArrowRight,
	IconFileSpreadsheet,
	IconFileTypePdf,
	IconMail,
	IconPuzzle,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { formatRelative, type Tone } from "#/components/app/format";
import { PageHeader, Panel, StoreMark, Tag } from "#/components/app/primitives";
import { listImports } from "#/features/ingress/imports/imports-ui.functions";
import { importKeys } from "./mapping-editor";

type Card = {
	to:
		| "/app/import/documents"
		| "/app/import/spreadsheets"
		| "/app/settings/sources"
		| "/app/settings/extension"
		| "/docs/api";
	icon: ReactNode;
	title: string;
	description: string;
	cta: string;
};

const CARDS: Card[] = [
	{
		to: "/app/import/documents",
		icon: <IconFileTypePdf />,
		title: "Documents",
		description:
			"Upload invoice/receipt PDFs or photos. Text is extracted (OCR for scans) and turned into orders.",
		cta: "Upload documents",
	},
	{
		to: "/app/import/spreadsheets",
		icon: <IconFileSpreadsheet />,
		title: "Spreadsheets",
		description:
			"CSV/XLSX order history exports: Amazon, Amazon Business, DigiKey, Mouser, eBay, AliExpress, PayPal or any store.",
		cta: "Import a file",
	},
	{
		to: "/app/settings/sources",
		icon: <IconMail />,
		title: "Email forwarding",
		description:
			"Forward order confirmations or connect an IMAP mailbox; confirmations are parsed as they arrive.",
		cta: "Set up email",
	},
	{
		to: "/app/settings/sources",
		icon: <IconArchive />,
		title: "Paperless-ngx",
		description:
			"Pull invoices and receipts from a Paperless-ngx instance on a schedule.",
		cta: "Connect Paperless",
	},
	{
		to: "/app/settings/extension",
		icon: <IconPuzzle />,
		title: "Browser extension",
		description:
			"Captures orders automatically while you browse store order pages, plus invoices on demand.",
		cta: "Set up the extension",
	},
	{
		to: "/docs/api",
		icon: <IconApi />,
		title: "Agent API",
		description:
			"Post structured orders from scripts or AI agents with an API key.",
		cta: "Read the API docs",
	},
];

const STATUS_TONES: Record<string, Tone> = {
	uploaded: "neutral",
	mapped: "primary",
	processing: "info",
	done: "success",
	failed: "danger",
};

export function ImportHub() {
	const recent = useQuery({
		queryKey: importKeys.list,
		queryFn: () => listImports(),
	});
	const rows = (recent.data ?? []).slice(0, 5);
	return (
		<div className="flex min-h-full flex-col">
			<PageHeader
				title="Import"
				description="Bring in orders from documents, spreadsheets, email and other tools. Everything lands as captures and goes through the same parsing, rules and review."
			/>
			<div className="flex flex-col gap-4 p-4">
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{CARDS.map((card) => (
						<Link
							key={card.title}
							to={card.to}
							className="group flex flex-col gap-2 rounded border border-border bg-card p-3 transition-colors hover:border-primary/50 hover:bg-accent/30"
						>
							<div className="flex items-center gap-2">
								<span className="inline-flex size-7 items-center justify-center rounded-sm bg-muted text-muted-foreground group-hover:text-primary [&_svg]:size-4">
									{card.icon}
								</span>
								<span className="text-sm font-semibold">{card.title}</span>
							</div>
							<p className="flex-1 text-xs text-muted-foreground">
								{card.description}
							</p>
							<span className="inline-flex items-center gap-1 text-xs text-primary">
								{card.cta}
								<IconArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
							</span>
						</Link>
					))}
				</div>
				{rows.length > 0 && (
					<Panel title="Recent spreadsheet imports" bodyClassName="p-0">
						<ul>
							{rows.map((row) => (
								<li
									key={row.id}
									className="border-b border-border/60 last:border-0"
								>
									<Link
										to="/app/import/spreadsheets"
										search={{ import: row.id }}
										className="flex h-8 items-center gap-3 px-3 text-xs hover:bg-accent/40"
									>
										<span className="min-w-0 flex-1 truncate">
											{row.fileName}
										</span>
										<StoreMark source={row.source} className="w-28" />
										<Tag tone={STATUS_TONES[row.status] ?? "neutral"}>
											{row.status}
										</Tag>
										<span className="w-20 text-right font-mono text-muted-foreground">
											{formatRelative(row.createdAt)}
										</span>
									</Link>
								</li>
							))}
						</ul>
					</Panel>
				)}
			</div>
		</div>
	);
}
