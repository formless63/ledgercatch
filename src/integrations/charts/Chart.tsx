import { useEffect, useId, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	XAxis,
	YAxis,
} from "recharts";

export type ChartDatum = { label: string; value: number | null | undefined };
export type ChartKind = "bar" | "line" | "area";
export interface ChartProps {
	data: readonly ChartDatum[];
	kind?: ChartKind;
	title: string;
	description?: string;
	className?: string;
}

function validData(data: readonly ChartDatum[]) {
	return data.filter((item): item is { label: string; value: number } =>
		Number.isFinite(item.value),
	);
}

export function Chart({
	data,
	kind = "line",
	title,
	description,
	className,
}: ChartProps) {
	const titleId = useId();
	const descriptionId = useId();
	const [enhanced, setEnhanced] = useState(false);
	const chartData = validData(data);
	useEffect(() => {
		setEnhanced(true);
		return () => setEnhanced(false);
	}, []);
	const common = {
		data: chartData,
		margin: { top: 8, right: 12, bottom: 8, left: 0 },
	} as const;
	const content =
		kind === "bar" ? (
			<BarChart {...common}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="label" />
				<YAxis />
				<Bar dataKey="value" fill="currentColor" isAnimationActive={false} />
			</BarChart>
		) : kind === "area" ? (
			<AreaChart {...common}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="label" />
				<YAxis />
				<Area
					dataKey="value"
					type="monotone"
					fill="currentColor"
					fillOpacity={0.14}
					stroke="currentColor"
					isAnimationActive={false}
				/>
			</AreaChart>
		) : (
			<LineChart {...common}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="label" />
				<YAxis />
				<Line
					dataKey="value"
					type="monotone"
					stroke="currentColor"
					strokeWidth={2}
					dot={false}
					isAnimationActive={false}
				/>
			</LineChart>
		);
	return (
		<div className={className} aria-busy={!enhanced}>
			<div
				role="img"
				aria-labelledby={`${titleId}${description ? ` ${descriptionId}` : ""}`}
			>
				<h2 id={titleId} className="sr-only">
					{title}
				</h2>
				{description && (
					<p id={descriptionId} className="sr-only">
						{description}
					</p>
				)}
				{enhanced ? (
					<ResponsiveContainer width="100%" height={240}>
						{content}
					</ResponsiveContainer>
				) : (
					<svg
						aria-hidden="true"
						viewBox="0 0 100 40"
						width="100%"
						height="240"
					/>
				)}
			</div>
			<table className="sr-only">
				<caption>{title}</caption>
				<thead>
					<tr>
						<th scope="col">Label</th>
						<th scope="col">Value</th>
					</tr>
				</thead>
				<tbody>
					{data.map((item) => (
						<tr key={`${item.label}-${String(item.value)}`}>
							<th scope="row">{item.label}</th>
							<td>
								{Number.isFinite(item.value) ? item.value : "Not available"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
