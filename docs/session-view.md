# Session view

This page describes how the browser UI behaves.
For the frontend's structure, data layer and tests, see [the architecture page](architecture.md#frontend-frontend).

## Session list

`pages/SessionListPage.tsx` shows one row per session.

- **Columns:** agent, title, workspace, last activity, start, duration, cost.
- **Sorting:** every column sorts; last activity, newest first, is the default; missing values sort last.
- **Filters:** agent, workspace and free text (`lib/filters.ts`), applied before sorting.
- **Paging:** in the browser (`lib/paging.ts`); page size 25/50/100/200, default 50, remembered in `localStorage`.
- **Live updates:** titles and costs fill in from SSE events; the current page is kept.
- **Errors:** a failed summary shows an `error` badge with the message.
- **Navigation:** click, Enter or Space opens `/sessions/<id>`.
- **Phone:** the same table scrolls horizontally.

## Session view

`components/SessionView.tsx` owns the view state; `NodeDrawer` and its tables render the details.

- `SessionPage` keys `SessionView` by session id, so a refetch keeps expansion, selection and zoom.
- `SessionHeader` shows title, badges, the findings switch and button, and headline figures.
- Diagnostics appear as a yellow alert below the header.

### State

| State | Meaning |
|---|---|
| `expanded` | expanded tree rows |
| `inspectionLocation` | inspected node, tab and selected entity, parsed from the URL |
| `inspectionRequest` | pending explicit inspection from a chart |
| `localMark` | transient mark on a row without a URL identity |
| `workflowLocation` | `scope` and `activity` from the URL |
| `workflowIndex` | indexed tree traversal with parents, depths and observations |
| `scopeOnly` | limit the agent list to the focused subtree |
| `followLatest` | reveal newly observed records (off by default) |
| `mobilePanel` | Workflow or Agents panel on phone |
| `findingsOpen` | findings drawer open |
| `range` | timeline zoom as `[from%, to%]` |
| `treePercent` | tree height in the split workspace, kept in `localStorage` |

- A memory map keeps the last tab, expanded rows and reading position per inspected node.
- Back and Forward restore snapshots of that memory, expansion, zoom and scroll.

### URL parameters

| Parameter | Meaning |
|---|---|
| `node`, `tab` | inspected node and drawer tab |
| `sel=node&entity=<id>` | selected node |
| `sel=call&owner=<id>&call=<key>` | selected LLM call |
| `sel=transcript&owner=<id>&entry=<id>` | selected transcript entry |
| `scope=<id>` | focused session, turn or agent subtree |
| `activity=all\|running\|waiting\|completed\|failed\|unknown` | activity filter |

Call keys:

- `id:<native-id>` when the native id is unique within its owner.
- Otherwise `time:<timestamp>` when the start is exact and unique.
- Otherwise the call cannot be selected durably.

History:

- Marking replaces the current history entry; explicit inspection pushes a new one.
- Closing the drawer removes only `node` and `tab`.
- Defaults (`scope` = session, `activity=all`) are omitted from the URL.
- Invalid values stay in the URL; the UI shows a fallback and an "unavailable" note.
- Legacy `tab=calls` resolves to Workflow.

### Marking and inspecting

- **Clicking** a row, bar or segment marks it; it does not open details, expand or scroll.
- **Triangles** expand and collapse.
- **Caption links** open details.
- **Context menu** (`InspectionMenu`): right-click, Shift+F10, the ContextMenu key or a 500 ms long-press.
- Overlapping items show a labelled list of candidates instead of picking one.
- Exact selection is tinted blue; related items (owners, ancestors, callers) are not highlighted.
- Rows without a URL identity get a local mark; it survives a refresh only when it still matches uniquely (`lib/localMarks.ts`).
- An artifact with several producers opens a chooser.

### Workflow state and scope

State (`lib/workflowState.ts`):

- Derived from a node's own completion events and its latest observed calls and events.
- Source order decides within one stream; timestamps decide otherwise; ties stay unknown.
- Running and waiting are inferred and labelled as such.
- Tool results, silence and file times never prove that an agent finished.
- Known states show as capsules (`WorkflowStatus`); unknown state shows nothing.

Scope (`lib/workflowScope.ts`):

- `scope` limits which hierarchy is shown; filters match each row's own state.
- Ancestors of matching rows stay visible, labelled "Context ancestor".
- Nodes sharing an `agent_id` count as one logical agent.
- `WorkflowBreadcrumbs` shows the focused hierarchy; `WorkflowToolbar` holds the controls.

Freshness:

- *Source updated* is the file mtime, *Fetched* is the query time, *Latest observed activity* is the newest record time.
- None of them proves that an agent is still running.

### Follow latest and reading position

- `lib/workflowReading.ts` keeps the visible row and offset stable across updates.
- Follow latest is off by default.
- It reveals only a new, unambiguous record within the current scope and filters.
- Scrolling, zooming, filtering, expanding, Escape or navigation pauses it.

### Agent summary

`AgentSummaryTable` shows one row per logical agent (`lib/agentSummary.ts`).

- **Fields:** agent, activity, topic, latest activity, model, cache TTL, resumes, duration, costs, total/input/output tokens.
- Agent 1 is the main agent, mapped to the session root, with the session title as topic.
- Totals cover the complete agent across turns and resumes; the cost share uses the whole session.
- The "focused subtree" switch filters rows but keeps complete totals.
- Clicking a row marks its representative node.

## Tree table and timeline

`components/TreeTimeline.tsx` is a grid with the columns topic, agent, model, duration, cost, tokens, context and timeline.

- Rows are the session, turns and agents; tool calls are never rows.
- Rows are virtualised: 30 px on desktop, 176 px on phone.
- **Topic:** indented, with toggle, kind mark (`▣` turn, `◆` agent), findings count, state and `failed` badge.
- **Agent:** id capsule (`AgentBadge`).
- **Cost:** inclusive `cost_total`; the tooltip shows `cost_own`.
- **Tokens:** sum of the four counts of `tokens_total`.
- **Context:** `context_peak`; the tooltip shows the compaction count.
- Metric cells are tinted by value (`lib/metricColor.ts`).
- A range slider above the timeline sets the zoom; `AxisLabels` shows five time labels.
- On phone the grid scrolls in its own container with 44 px hit areas.

### Activity track

`ActivityTrack` draws one node's activity, in the tree and in the drawer's `NodeTimeline`:

- **Background:** the node's span (gray turn, violet agent, red if failed).
- **Top lane:** own LLM calls (gray bars or ticks) and tool calls (blue, red if failed), merged where they overlap.
- **Bottom lane:** direct sub-agents (violet), merged where they overlap.
- Geometry lives in `lib/timeline.ts`.

## Node drawer

`NodeDrawer` opens on the right for the inspected node.

- **Width:** 60 % by default, adjustable from 45 % to 90 % or full width; full screen on phone.
- **Header:** kind, model and tool badges, and a To parent button.
- **Tabs:** Overview, Workflow and Content; tools have only Overview and Content, with Content as default.
- All tabs stay mounted.

### Overview tab

- `NodeOverview`: topic, outcome, prompt and result previews, duration, costs, call counts and a token table.
- `NodeFindings`: findings grouped by heuristic and severity, with links, costs and raw evidence (`FindingEvidence`).
- `CacheSection` (`lib/cache.ts`): cache reads and writes, 5m/1h subsets and cost estimates, for own and inclusive calls.
- Partial data shows its coverage; recorded zero is distinct from missing.
- 5m/1h rows are subsets of total writes and must not be added.

### Workflow tab

Charts, in this order, sharing one time axis (`lib/drawerTimeDomain.ts`):

- **`NodeTimeline`:** the node's activity and one track per sub-agent (or per turn for the session).
- **`CostSection`** (`lib/cost.ts`): cost per LLM call; unknown cost stays distinct from zero.
- **`ContextSection`** (`lib/context.ts`): context per call as cache-read, cache-write and uncached bars, with compaction marks.

Below the charts, two collapsible sections:

- **Sub-agents** (`ChildNodesTable`): start, duration, topic, model, tokens and costs; rows expand into their own calls.
- **LLM calls** (`LlmCallsTable`): calls, tool invocations and other activity in time order.

LLM calls table:

- Columns: Time, Item, Duration, Cost, Tokens.
- `lib/executionSequence.ts` merges calls and events, `lib/toolExecutions.ts` pairs tool starts and results, `lib/inspectionSequence.ts` builds rows and groups.
- Consecutive tool calls form a collapsed group.
- Expanded tool details show timing, outcome, command, paths and Requester / Result user links.
- Tool rows never inherit LLM cost or tokens.
- `SequenceControls` sets the sort order and compact/all mode.

### Content tab and transcripts

- `ArtifactsTable` (`lib/artifacts.ts`): files written or edited by the node's own tools.
- Full prompt, result and tool arguments load on demand.
- `TranscriptSection` loads 50 entry headers at a time; bodies load only when a row is opened.
- Search covers the current owner or the whole session.
- Message and reasoning text render as safe Markdown (`MarkdownMessage`); tool output stays preformatted.
- Sender and recipient labels come from the session tree (`lib/transcript.ts`).
- `RecordedContentLink` links a call or event to its transcript entry when the match is unique.
- Back restores query, scope, page, open rows and position; Follow latest is available outside search.

## Findings drawer

- `FindingsDrawer` lists all findings, by severity and then heuristic id.
- Clicking a row marks it; the message link opens the supporting node.
- Evidence links work as in the node view (`lib/findingReferences.ts`).

## Display conventions

From `lib/format.ts`:

- Missing values show as `–`; estimated values get a `≈` prefix.
- USD costs show as `$0.0123` or `$1.23`; credits as `$0.01 (1.23 cr)`.
- Durations range from `ms` to `h m`; tokens use `k` and `M`.
- Titles are cut to 100 characters with `…`.
- Agent labels come from `AGENT_LABELS`; severity colours from `lib/severity.ts`.

## Stable test ids

The Playwright specs select elements by `data-testid`; keep these stable:

| Test id | Element |
|---|---|
| `session-row-<id>` | session list row |
| `tree-row-<key>`, `toggle-<key>` | tree row and its triangle |
| `track-<id>` | `ActivityTrack` |
| `context-<id>` | `ContextCell` |
| `context-section`, `context-chart` | `ContextSection` and its chart |
| `cost-section`, `cost-chart` | `CostSection` and its chart |
| `cost-bar-<owner>-<index>`, `call-cost-<owner>-<index>` | one call's cost bar and cost cell |
| `node-timeline`, `timeline-row-<id>` | `NodeTimeline` and one track |
| `turn-<id>`, `sub-agent-<id>` | `ChildNodesTable` rows |
| `artifact-<path>` | `ArtifactsTable` row |
| `finding-<W>-<node>` | finding row |
