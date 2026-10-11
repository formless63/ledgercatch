import {
	type ColumnDef,
	type ColumnVisibilityState,
	columnFilteringFeature,
	columnVisibilityFeature,
	createFilteredRowModel,
	createPaginatedRowModel,
	createSortedRowModel,
	filterFn_includesString,
	functionalUpdate,
	globalFilteringFeature,
	type OnChangeFn,
	type PaginationState,
	type ReactTable,
	type RowData,
	type RowSelectionState,
	rowPaginationFeature,
	rowSelectionFeature,
	rowSortingFeature,
	type SortingState,
	sortFns,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import { type ReactNode, useMemo, useRef } from "react";

export const dataTableFeatures = tableFeatures({
	columnFilteringFeature,
	columnVisibilityFeature,
	globalFilteringFeature,
	rowSortingFeature,
	rowPaginationFeature,
	rowSelectionFeature,
	filteredRowModel: createFilteredRowModel(),
	sortedRowModel: createSortedRowModel(),
	paginatedRowModel: createPaginatedRowModel(),
	filterFns: { includesString: filterFn_includesString },
	sortFns,
});
export type DataTableColumn<T extends RowData> = ColumnDef<
	typeof dataTableFeatures,
	T
>;
export type DataTableInstance<T extends RowData> = ReactTable<
	typeof dataTableFeatures,
	T
>;
// Each slice is either internally owned or a value/callback pair. A missing
// callback must never silently freeze a supplied controlled value.
type Slice<K extends string, C extends string, V> =
	| ({ [P in K]: V } & { [P in C]: OnChangeFn<V> })
	| ({ [P in K]?: never } & { [P in C]?: never });
export type DataTableProps<T extends RowData> = {
	data: T[];
	columns: DataTableColumn<T>[];
	getRowId: (row: T, index: number) => string;
	ariaLabel: string;
	caption?: ReactNode;
	emptyMessage?: ReactNode;
	manualSorting?: boolean;
	manualFiltering?: boolean;
	manualPagination?: boolean;
	pageCount?: number;
	rowCount?: number;
	/** Render application-owned filters, selection and pagination controls. */
	children?: (table: DataTableInstance<T>) => ReactNode;
} & Slice<"sorting", "onSortingChange", SortingState> &
	Slice<"globalFilter", "onGlobalFilterChange", string> &
	Slice<"pagination", "onPaginationChange", PaginationState> &
	Slice<"columnVisibility", "onColumnVisibilityChange", ColumnVisibilityState> &
	Slice<"rowSelection", "onRowSelectionChange", RowSelectionState>;

export function DataTable<T extends RowData>(props: DataTableProps<T>) {
	// useTable merges options across renders. Always replace callbacks, including
	// when ownership returns to the native base atoms after controlled state.
	const instance = useRef<DataTableInstance<T> | null>(null);
	const internal = useMemo(
		() => ({
			sorting: ((value) =>
				instance.current?.baseAtoms.sorting.set((previous) =>
					functionalUpdate(value, previous),
				)) as OnChangeFn<SortingState>,
			globalFilter: ((value) =>
				instance.current?.baseAtoms.globalFilter.set((previous) =>
					functionalUpdate(value, previous),
				)) as OnChangeFn<string>,
			pagination: ((value) =>
				instance.current?.baseAtoms.pagination.set((previous) =>
					functionalUpdate(value, previous),
				)) as OnChangeFn<PaginationState>,
			columnVisibility: ((value) =>
				instance.current?.baseAtoms.columnVisibility.set((previous) =>
					functionalUpdate(value, previous),
				)) as OnChangeFn<ColumnVisibilityState>,
			rowSelection: ((value) =>
				instance.current?.baseAtoms.rowSelection.set((previous) =>
					functionalUpdate(value, previous),
				)) as OnChangeFn<RowSelectionState>,
		}),
		[],
	);
	const table = useTable({
		features: dataTableFeatures,
		data: props.data,
		columns: props.columns,
		getRowId: props.getRowId,
		initialState: { pagination: { pageIndex: 0, pageSize: 20 } },
		state: {
			...(props.sorting === undefined ? {} : { sorting: props.sorting }),
			...(props.globalFilter === undefined
				? {}
				: { globalFilter: props.globalFilter }),
			...(props.pagination === undefined
				? {}
				: { pagination: props.pagination }),
			...(props.columnVisibility === undefined
				? {}
				: { columnVisibility: props.columnVisibility }),
			...(props.rowSelection === undefined
				? {}
				: { rowSelection: props.rowSelection }),
		},
		onSortingChange: props.onSortingChange ?? internal.sorting,
		onGlobalFilterChange: props.onGlobalFilterChange ?? internal.globalFilter,
		onPaginationChange: props.onPaginationChange ?? internal.pagination,
		onColumnVisibilityChange:
			props.onColumnVisibilityChange ?? internal.columnVisibility,
		onRowSelectionChange: props.onRowSelectionChange ?? internal.rowSelection,
		manualSorting: props.manualSorting ?? false,
		manualFiltering: props.manualFiltering ?? false,
		manualPagination: props.manualPagination ?? false,
		pageCount: props.pageCount,
		rowCount: props.rowCount,
		globalFilterFn: "includesString",
	});
	instance.current = table;
	const rows = table.getRowModel().rows;
	return (
		<>
			{props.children?.(table)}
			<table aria-label={props.ariaLabel}>
				{props.caption != null ? <caption>{props.caption}</caption> : null}
				<thead>
					{table.getHeaderGroups().map((group) => (
						<tr key={group.id}>
							{group.headers.map((header) => {
								const sort = header.column.getIsSorted();
								const sortable =
									!header.isPlaceholder &&
									header.subHeaders.length === 0 &&
									header.column.getCanSort();
								return (
									<th
										key={header.id}
										colSpan={header.colSpan}
										scope={header.subHeaders.length ? "colgroup" : "col"}
										aria-sort={
											sortable
												? sort === "asc"
													? "ascending"
													: sort === "desc"
														? "descending"
														: "none"
												: undefined
										}
									>
										{header.isPlaceholder ? null : sortable ? (
											<button
												type="button"
												onClick={header.column.getToggleSortingHandler()}
											>
												<table.FlexRender header={header} />
											</button>
										) : (
											<table.FlexRender header={header} />
										)}
									</th>
								);
							})}
						</tr>
					))}
				</thead>
				<tbody>
					{rows.length === 0 ? (
						<tr>
							<td colSpan={Math.max(table.getVisibleLeafColumns().length, 1)}>
								{props.emptyMessage ?? "No results."}
							</td>
						</tr>
					) : (
						rows.map((row) => (
							<tr key={row.id} data-selected={row.getIsSelected() || undefined}>
								{row.getVisibleCells().map((cell) => (
									<td key={cell.id}>
										<table.FlexRender cell={cell} />
									</td>
								))}
							</tr>
						))
					)}
				</tbody>
			</table>
		</>
	);
}
