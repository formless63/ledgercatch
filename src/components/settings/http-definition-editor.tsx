import { useState } from "react";
import { Button, Field, Input, Select } from "#/components/app/primitives";
import {
	exampleDefinition,
	type ImportedOperation,
	inspectOpenApi,
	parseDefinition,
	previewExpense,
} from "#/features/connectors/custom-http";

export function HttpDefinitionEditor({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	const [operations, setOperations] = useState<ImportedOperation[]>([]);
	const [selected, setSelected] = useState("");
	const [error, setError] = useState("");
	const [preview, setPreview] = useState("");
	const op = operations[Number(selected)];
	return (
		<div className="space-y-2 sm:col-span-2">
			<Field
				label="Inspect OpenAPI JSON"
				hint="Upload up to 256 KiB. Only inline OpenAPI 3.0/3.1 schemas; no references or network requests."
			>
				<Input
					type="file"
					accept=".json,application/json"
					onChange={async (e) => {
						const f = e.target.files?.[0];
						if (!f) return;
						try {
							if (f.size > 256 * 1024) throw new Error("File exceeds 256 KiB");
							setOperations(inspectOpenApi(await f.text()));
							setSelected("0");
							setError("");
						} catch (err) {
							setError(err instanceof Error ? err.message : "Invalid OpenAPI");
						}
					}}
				/>
			</Field>
			{operations.length > 0 && (
				<>
					<Select
						value={selected}
						onChange={(e) => setSelected(e.target.value)}
					>
						{operations.map((o, i) => (
							<option key={`${o.method} ${o.path}`} value={i}>
								{o.method} {o.path} — {o.summary}
							</option>
						))}
					</Select>
					<pre className="max-h-40 overflow-auto text-xs">
						{JSON.stringify(op?.requestSchema, null, 2)}
					</pre>
					<Button
						onClick={() => {
							try {
								const d = parseDefinition(value);
								if (op.method === "GET")
									d.test = { method: "GET", path: op.path };
								else
									d.expense = {
										...d.expense,
										method: op.method,
										path: op.path,
									};
								onChange(JSON.stringify(d, null, 2));
								setError("");
							} catch {
								setError(
									"Add a valid definition first, then select an operation",
								);
							}
						}}
					>
						Use selected operation
					</Button>
				</>
			)}
			<Field
				label="Operations and mappings (JSON)"
				hint="Configure mappings and confirm that your provider durably enforces the idempotency header. The example is for the local demo provider only."
			>
				<textarea
					className="min-h-64 w-full rounded border bg-background p-2 font-mono text-xs"
					required
					value={value}
					onChange={(e) => onChange(e.target.value)}
				/>
			</Field>
			<div className="flex gap-2">
				<Button
					onClick={() => onChange(JSON.stringify(exampleDefinition, null, 2))}
				>
					Load demo provider example
				</Button>
				<Button
					onClick={() => {
						try {
							const d = parseDefinition(value);
							setPreview(
								JSON.stringify(
									{
										method: d.expense.method,
										path: d.expense.path,
										body: previewExpense(d, {
											reference: "preview-synthetic-001",
											orderRef: "synthetic 001",
											date: "2026-09-01",
											vendorName: "Example Supplies",
											amount: "42.50",
											currency: "USD",
											memo: "Synthetic preview",
											reimbursable: true,
											lineSummary: ["1 × Notebook"],
										}),
									},
									null,
									2,
								),
							);
							setError("");
						} catch {
							setError(
								"Invalid definition: check operations, mappings and idempotency confirmation",
							);
						}
					}}
				>
					Dry run with synthetic expense
				</Button>
			</div>
			{error && (
				<p role="alert" className="text-sm text-red-500">
					{error}
				</p>
			)}
			{preview && (
				<div>
					<p className="text-xs">Preview only. No request was sent.</p>
					<pre className="overflow-auto text-xs">{preview}</pre>
				</div>
			)}
		</div>
	);
}
