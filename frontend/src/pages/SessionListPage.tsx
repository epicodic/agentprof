// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import {
  Alert,
  Badge,
  Group,
  Loader,
  NativeSelect,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  type Updater,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useSessions } from "../api/hooks";
import type { SummaryOut } from "../api/types";
import { distinct, durationMs, filterRows, sessionListMetricScales } from "../lib/filters";
import {
  agentLabel,
  formatCost,
  formatDuration,
  formatTimestamp,
  MISSING,
  truncateTitle,
  withProvenance,
} from "../lib/format";
import { colorForMetric } from "../lib/metricColor";
import { clampPage, PAGE_SIZES, pageCount, parsePageSize } from "../lib/paging";
import classes from "./SessionListPage.module.css";

const ALL_AGENTS = "all";
const NOWRAP_COLUMNS = new Set(["agent", "last_activity", "start", "duration", "cost"]);
const AGENT_COLUMN_WIDTH = 120;
const PAGE_SIZE_KEY = "agentprof.sessionList.pageSize";

function storedPageSize(): number {
  try {
    return parsePageSize(localStorage.getItem(PAGE_SIZE_KEY));
  } catch {
    return parsePageSize(null);
  }
}

function storePageSize(size: number) {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(size));
  } catch {
    // storage unavailable: the size just is not remembered
  }
}

function ErrorBadge({ row, isPhone }: { row: SummaryOut; isPhone: boolean }) {
  if (row.state !== "error") return null;
  if (!isPhone)
    return (
      <Tooltip label={row.error ?? "error"} multiline w={320}>
        <Badge color="red" size="sm" style={{ flexShrink: 0 }}>
          error
        </Badge>
      </Tooltip>
    );
  return (
    <details
      className={classes.errorDisclosure}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <summary aria-label="Show summary error" data-testid="summary-error-disclosure">
        <Badge color="red" size="sm" style={{ flexShrink: 0 }}>
          error
        </Badge>
      </summary>
      <Text size="xs" role="note">
        {row.error ?? "Summary failed"}
      </Text>
    </details>
  );
}

const columns = (scales: ReturnType<typeof sessionListMetricScales>, isPhone: boolean): ColumnDef<SummaryOut>[] => [
  {
    accessorKey: "agent",
    header: "Agent",
    cell: (context) => (
      <Badge variant="light" size="sm">
        {agentLabel(context.getValue<string>())}
      </Badge>
    ),
  },
  {
    accessorKey: "title",
    header: "Title",
    cell: (context) => (
      <Group gap="xs" wrap="nowrap" className={classes.titleCell}>
        {isPhone ? (
          <details
            className={classes.fullValue}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <summary>
              <Text size="sm" lineClamp={1} title={context.getValue<string>()}>
                {truncateTitle(context.getValue<string>())}
              </Text>
            </summary>
            <Text size="sm" className={classes.expandedValue} title={context.getValue<string>()}>
              {truncateTitle(context.getValue<string>())}
            </Text>
          </details>
        ) : (
          <Text size="sm" lineClamp={1} title={context.getValue<string>()}>
            {truncateTitle(context.getValue<string>())}
          </Text>
        )}
        <ErrorBadge row={context.row.original} isPhone={isPhone} />
      </Group>
    ),
  },
  {
    id: "workspace",
    accessorFn: (row) => row.workspace ?? undefined,
    header: "Workspace",
    sortUndefined: "last",
    cell: (context) =>
      isPhone ? (
        <details
          className={classes.fullValue}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <summary>
            <Text size="xs" c="dimmed" lineClamp={1}>
              {context.getValue<string | undefined>() ?? MISSING}
            </Text>
          </summary>
          <Text size="xs" c="dimmed" className={classes.expandedValue}>
            {context.getValue<string | undefined>() ?? MISSING}
          </Text>
        </details>
      ) : (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {context.getValue<string | undefined>() ?? MISSING}
        </Text>
      ),
  },
  {
    id: "last_activity",
    accessorFn: (row) => row.last_activity_ms ?? undefined,
    header: "Last activity",
    sortUndefined: "last",
    cell: (context) => formatTimestamp(context.getValue<number | undefined>()),
  },
  {
    id: "start",
    accessorFn: (row) => row.start_ms ?? undefined,
    header: "Start",
    sortUndefined: "last",
    cell: (context) => formatTimestamp(context.getValue<number | undefined>()),
  },
  {
    id: "duration",
    accessorFn: (row) => durationMs(row) ?? undefined,
    header: "Duration",
    sortUndefined: "last",
    cell: (context) => (
      <Text
        data-testid={`session-duration-${context.row.original.id}`}
        inherit
        c={colorForMetric(durationMs(context.row.original), scales.duration) ?? "dimmed"}
      >
        {formatDuration(context.getValue<number | undefined>())}
      </Text>
    ),
  },
  {
    id: "cost",
    accessorFn: (row) => row.cost_total?.usd ?? undefined,
    header: "Cost",
    sortUndefined: "last",
    cell: (context) => {
      const cost = context.row.original.cost_total;
      return (
        <Text inherit c={colorForMetric(cost?.usd, scales.cost) ?? "dimmed"}>
          {cost === null ? MISSING : withProvenance(formatCost(cost), cost)}
        </Text>
      );
    },
  },
];

function sortMark(direction: false | "asc" | "desc"): string {
  if (direction === "asc") return " ▲";
  if (direction === "desc") return " ▼";
  return "";
}

export function SessionListPage() {
  const isPhone = useMediaQuery("(max-width: 48em)");
  const query = useSessions();
  const navigate = useNavigate();
  const [agent, setAgent] = useState(ALL_AGENTS);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "last_activity", desc: true }]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(storedPageSize);
  const rows = query.data ?? [];
  const data = useMemo(
    () => filterRows(rows, { agent: agent === ALL_AGENTS ? null : agent, workspace, text }),
    [rows, agent, workspace, text],
  );
  const scales = useMemo(() => sessionListMetricScales(data), [data]);
  const tableColumns = useMemo(() => columns(scales, isPhone), [scales, isPhone]);
  const pageIndex = clampPage(page, data.length, pageSize);
  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting, pagination: { pageIndex, pageSize } },
    onSortingChange: (updater: Updater<SortingState>) => {
      setSorting(updater);
      setPage(0);
    },
    // Live updates change `data` all the time; only the user's own actions go back to the first page.
    autoResetPageIndex: false,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
  // Every filter change goes back to the first page.
  function filtered<T>(set: (value: T) => void): (value: T) => void {
    return (value) => {
      set(value);
      setPage(0);
    };
  }

  if (query.isPending) return <Loader m="xl" />;
  if (query.isError) {
    return (
      <Alert color="red" m="md" title="Cannot load sessions">
        {query.error.message}
      </Alert>
    );
  }

  return (
    <Stack p="md" gap="sm" className={classes.page}>
      <Group justify="space-between">
        <Title order={2}>agentprof</Title>
        <Text size="sm" c="dimmed">
          {data.length} of {rows.length} sessions
        </Text>
      </Group>
      <Group className={classes.filters}>
        <SegmentedControl
          className={classes.agentFilter}
          value={agent}
          onChange={filtered(setAgent)}
          data={[ALL_AGENTS, ...distinct(rows.map((row) => row.agent))].map((value) => ({
            value,
            label: agentLabel(value),
          }))}
        />
        <Select
          placeholder="Workspace"
          clearable
          searchable
          value={workspace}
          onChange={filtered(setWorkspace)}
          data={distinct(rows.map((row) => row.workspace))}
          aria-label="Workspace"
          w={360}
        />
        <TextInput
          placeholder="Search"
          value={text}
          onChange={(event) => filtered(setText)(event.currentTarget.value)}
          aria-label="Search"
          w={260}
        />
      </Group>
      {isPhone && (
        <Group className={classes.phoneSorting} grow>
          <NativeSelect
            label="Sort sessions"
            value={sorting[0]?.id ?? "last_activity"}
            data={[
              { value: "agent", label: "Agent" },
              { value: "title", label: "Title" },
              { value: "workspace", label: "Workspace" },
              { value: "last_activity", label: "Last activity" },
              { value: "start", label: "Start" },
              { value: "duration", label: "Duration" },
              { value: "cost", label: "Cost" },
            ]}
            onChange={(event) => table.setSorting([{ id: event.currentTarget.value, desc: sorting[0]?.desc ?? true }])}
          />
          <NativeSelect
            label="Sort direction"
            value={sorting[0]?.desc ? "desc" : "asc"}
            data={[
              { value: "desc", label: "Descending" },
              { value: "asc", label: "Ascending" },
            ]}
            onChange={(event) =>
              table.setSorting([{ id: sorting[0]?.id ?? "last_activity", desc: event.currentTarget.value === "desc" }])
            }
          />
        </Group>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The named scroll region needs keyboard focus for horizontal table navigation. */}
      <section className={classes.tableScroll} aria-label="Sessions table" tabIndex={0}>
        <Table highlightOnHover stickyHeader>
          <Table.Thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <Table.Tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Table.Th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    style={{ cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sortMark(header.column.getIsSorted())}
                  </Table.Th>
                ))}
              </Table.Tr>
            ))}
          </Table.Thead>
          <Table.Tbody>
            {table.getRowModel().rows.map((row) => (
              <Table.Tr
                key={row.id}
                data-testid={`session-row-${row.id}`}
                tabIndex={0}
                onClick={() => navigate(`/sessions/${encodeURIComponent(row.id)}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    navigate(`/sessions/${encodeURIComponent(row.id)}`);
                  } else if (event.key === " ") {
                    event.preventDefault();
                    navigate(`/sessions/${encodeURIComponent(row.id)}`);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                {row.getVisibleCells().map((cell) => (
                  <Table.Td
                    key={cell.id}
                    style={
                      NOWRAP_COLUMNS.has(cell.column.id)
                        ? {
                            whiteSpace: "nowrap",
                            minWidth: cell.column.id === "agent" ? AGENT_COLUMN_WIDTH : undefined,
                          }
                        : undefined
                    }
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </section>
      <Group justify="space-between" className={classes.pagination}>
        <Pagination
          total={pageCount(data.length, pageSize)}
          value={pageIndex + 1}
          onChange={(value) => setPage(value - 1)}
        />
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            Rows per page
          </Text>
          <Select
            aria-label="Rows per page"
            data={PAGE_SIZES.map(String)}
            value={String(pageSize)}
            onChange={(value) => {
              const size = parsePageSize(value);
              setPageSize(size);
              storePageSize(size);
              setPage(0);
            }}
            allowDeselect={false}
            w={90}
          />
        </Group>
      </Group>
    </Stack>
  );
}
