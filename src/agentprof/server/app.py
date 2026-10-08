# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""The FastAPI application: session list, analysed sessions, node details and live updates."""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse

from agentprof.analysis.agent_summary import agent_ids
from agentprof.model import Node, Session, iter_nodes
from agentprof.pricing import PriceTable
from agentprof.registry import EventKind, Registry, RegistryEvent, SessionUnavailable
from agentprof.server.pricing_schema import PricingOut, pricing_out
from agentprof.server.schemas import (
    AgentSummaryOut,
    ApiEndpointOut,
    ApiIndexOut,
    DiagnosticsDetailOut,
    FindingOut,
    NodeDetailOut,
    ProjectedSessionOut,
    SessionOut,
    SummaryOut,
    activity_flags,
    agent_summary_out,
    diagnostics_detail_out,
    diagnostics_out,
    finding_out,
    node_detail_out,
    node_out,
    session_out,
    summary_out,
)

_KEEP_ALIVE_S = 15.0
_STATIC_DIR = Path(__file__).parent / "static"
_ASSETS_PREFIX = "assets/"
_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}  # Vite puts a content hash in asset names
_NO_CACHE = {"Cache-Control": "no-cache"}
_SESSION_FIELDS = ("session", "diagnostics", "tree")
_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
_PLACEHOLDER_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>agentprof</title><!-- API discovery: /api --></head>
<body>
<h1>agentprof</h1>
<p>The frontend assets are missing: the browser UI is not built yet.</p>
<p>The API is running: <a href="/api/sessions">/api/sessions</a> · <a href="/docs">/docs</a></p>
</body>
</html>
"""


class Broadcaster:
    """Hands registry events from any thread to the queues of connected event-stream clients.

    A `None` in a queue tells its stream to end.
    """

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queues: set[asyncio.Queue[RegistryEvent | None]] = set()

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def open(self) -> asyncio.Queue[RegistryEvent | None]:
        queue: asyncio.Queue[RegistryEvent | None] = asyncio.Queue()
        self._queues.add(queue)
        return queue

    def close(self, queue: asyncio.Queue[RegistryEvent | None]) -> None:
        self._queues.discard(queue)

    def publish(self, event: RegistryEvent) -> None:
        """Thread-safe: deliver `event` on the server's event loop; dropped before the server has started."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._deliver, event)

    def _deliver(self, event: RegistryEvent | None) -> None:
        for queue in list(self._queues):
            queue.put_nowait(event)

    def end_streams(self) -> None:
        """Thread-safe: make every connected stream end, so a shutting-down server need not wait for the browser."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._deliver, None)


def format_event(event: RegistryEvent, registry: Registry) -> str | None:
    """The server-sent-event message for `event`, or `None` if its row vanished meanwhile."""
    if event.kind is EventKind.REMOVED:
        return f"event: removed\ndata: {json.dumps({'id': event.session_id})}\n\n"
    row = registry.row(event.session_id)
    if row is None:
        return None
    return f"event: updated\ndata: {summary_out(row).model_dump_json()}\n\n"


async def event_stream(
    queue: asyncio.Queue[RegistryEvent | None],
    format_message: Callable[[RegistryEvent], str | None],
    is_disconnected: Callable[[], Awaitable[bool]],
    keep_alive_s: float,
) -> AsyncIterator[str]:
    """Server-sent-event messages for queued events, with a keep-alive comment when idle."""
    yield ": connected\n\n"
    while not await is_disconnected():
        try:
            event = await asyncio.wait_for(queue.get(), timeout=keep_alive_s)
        except TimeoutError:
            yield ": keep-alive\n\n"
            continue
        if event is None:
            return
        message = format_message(event)
        if message is not None:
            yield message


def static_file(static_dir: Path, path: str) -> Path | None:
    """The existing file under `static_dir` that `path` names, or `None`; never resolves outside `static_dir`."""
    if not path:
        return None
    root = static_dir.resolve()
    candidate = (root / path).resolve()
    return candidate if candidate.is_relative_to(root) and candidate.is_file() else None


def wants_session_json(request: Request) -> bool:
    """Return whether a session page request explicitly asks for JSON."""
    if request.query_params.get("format") == "json":
        return True
    for item in request.headers.get("accept", "").lower().split(","):
        media_type, *parameters = item.split(";")
        if media_type.strip() != "application/json":
            continue
        quality = 1.0
        for parameter in parameters:
            name, _, value = parameter.strip().partition("=")
            if name == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
                break
        if 0 < quality <= 1:
            return True
    return False


def session_html(html: str, session_id: str) -> str:
    """Add the session's JSON alternate and an API discovery hint to the SPA shell."""
    url = f"/api/sessions/{quote(session_id, safe='')}"
    hint = "" if "<!-- API discovery: /api -->" in html else "<!-- API discovery: /api -->\n"
    markup = f'<link rel="alternate" type="application/json" href="{url}">\n{hint}'
    if "</head>" in html:
        return html.replace("</head>", f"{markup}</head>", 1)
    return f"{markup}{html}"


def _mark_omitted(node: dict[str, Any], source: Node, depth: int) -> None:
    """Mark omitted descendants on a tree already mapped only to `depth`."""
    node["children_omitted"] = bool(source.children) if depth == 0 else False
    if depth > 0:
        for mapped, child in zip(node["children"], source.children, strict=True):
            _mark_omitted(mapped, child, depth - 1)


def _project_session(session: Session, mtime: float, depth: int | None, fields: str | None) -> JSONResponse:
    """Select documented top-level groups and optionally bound tree depth."""
    selected = _SESSION_FIELDS if fields is None else tuple(part.strip() for part in fields.split(","))
    if not selected or any(part not in _SESSION_FIELDS for part in selected):
        raise HTTPException(status_code=422, detail="fields must contain: session, diagnostics, tree")
    projected: dict[str, Any] = {}
    if "session" in selected:
        projected.update(
            id=session.id,
            agent=session.agent,
            title=session.title,
            workspace=session.workspace,
            mtime=mtime,
            sources=session.sources,
        )
    if "diagnostics" in selected:
        projected["diagnostics"] = diagnostics_out(session.diagnostics).model_dump(mode="json")
    if "tree" in selected:
        root = node_out(
            session.root,
            agent_ids(session.root),
            frontier=session.root.end.value,
            max_depth=depth,
            activity_flags=activity_flags(session.root, session.root.end.value) if depth is not None else None,
        ).model_dump(mode="json")
        if depth is not None:
            _mark_omitted(root, session.root, depth)
        projected["root"] = root
    return JSONResponse(projected)


def _sorted_findings(root: Node) -> list[FindingOut]:
    """Flatten attached findings and order known avoidable USD, severity, then event time."""
    attached: list[tuple[FindingOut, float | None]] = []
    for node in iter_nodes(root):
        for finding in node.findings:
            observed = finding.evidence.get("call_start_ms")
            time = (
                float(observed)
                if isinstance(observed, (int, float)) and not isinstance(observed, bool)
                else node.start.value
            )
            attached.append((finding_out(finding), time))

    def order(item: tuple[FindingOut, float | None]) -> tuple[bool, float, int, bool, float, str, str]:
        finding, time = item
        usd = finding.estimated_avoidable_cost.usd
        return (
            usd is None,
            -usd if usd is not None else 0.0,
            _SEVERITY_ORDER.get(finding.severity, len(_SEVERITY_ORDER)),
            time is None,
            time if time is not None else 0.0,
            finding.heuristic_id,
            finding.node_id,
        )

    return [finding for finding, _ in sorted(attached, key=order)]


def create_app(registry: Registry, static_dir: Path = _STATIC_DIR, pricing: PriceTable | None = None) -> FastAPI:
    """Build the application with the effective pricing table and built frontend."""
    broadcaster = Broadcaster()
    price_table = pricing if pricing is not None else PriceTable.load()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        broadcaster.bind(asyncio.get_running_loop())
        unsubscribe = registry.subscribe(broadcaster.publish)
        yield
        unsubscribe()

    app = FastAPI(title="agentprof", lifespan=lifespan)
    app.state.end_streams = broadcaster.end_streams

    @app.get("/api/", include_in_schema=False)
    @app.get("/api", summary="Discover the public API")
    def api_index() -> ApiIndexOut:
        endpoints: list[ApiEndpointOut] = []
        for path, methods in app.openapi()["paths"].items():
            if not path.startswith("/api"):
                continue
            for method, operation in methods.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                endpoints.append(
                    ApiEndpointOut(
                        method=method.upper(),
                        path=path,
                        parameters=[parameter["name"] for parameter in operation.get("parameters", [])],
                        description=operation.get("summary") or operation.get("description") or path,
                    )
                )
        endpoints.sort(key=lambda endpoint: (endpoint.path, endpoint.method))
        return ApiIndexOut(endpoints=endpoints)

    @app.get("/api/sessions")
    def list_sessions() -> list[SummaryOut]:
        return [summary_out(row) for row in registry.rows()]

    @app.get("/api/pricing", summary="Inspect the effective price table")
    def get_pricing() -> PricingOut:
        return pricing_out(price_table)

    @app.get("/api/sessions/events")
    async def session_events(request: Request) -> StreamingResponse:
        queue = broadcaster.open()

        async def stream() -> AsyncIterator[str]:
            try:
                messages = event_stream(
                    queue, lambda event: format_event(event, registry), request.is_disconnected, _KEEP_ALIVE_S
                )
                async for message in messages:
                    yield message
            finally:
                broadcaster.close(queue)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.get("/api/sessions/{session_id}/summary", summary="Summarize a session by agent")
    def get_agent_summary(session_id: str) -> AgentSummaryOut:
        try:
            session, mtime = registry.session(session_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=f"unknown session {session_id!r}") from error
        except SessionUnavailable as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return agent_summary_out(session, mtime)

    @app.get("/api/sessions/{session_id}/diagnostics", summary="Inspect session parse diagnostics")
    def get_diagnostics(session_id: str) -> DiagnosticsDetailOut:
        try:
            session, _ = registry.session(session_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=f"unknown session {session_id!r}") from error
        except SessionUnavailable as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return diagnostics_detail_out(session.diagnostics)

    @app.get("/api/sessions/{session_id}/findings", summary="List a session's findings by estimated cost and severity")
    def get_findings(session_id: str) -> list[FindingOut]:
        try:
            session, _ = registry.session(session_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=f"unknown session {session_id!r}") from error
        except SessionUnavailable as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return _sorted_findings(session.root)

    @app.get("/api/sessions/{session_id}", response_model=SessionOut | ProjectedSessionOut)
    def get_session(
        session_id: str,
        depth: Annotated[
            int | None,
            Query(
                ge=0,
                description="Maximum depth from root (root is 0); truncated nodes report children_omitted.",
            ),
        ] = None,
        fields: Annotated[
            str | None,
            Query(description="Groups: session (identity and sources), diagnostics, tree (root); comma-separated."),
        ] = None,
    ) -> SessionOut | JSONResponse:
        try:
            session, mtime = registry.session(session_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=f"unknown session {session_id!r}") from error
        except SessionUnavailable as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return (
            session_out(session, mtime)
            if depth is None and fields is None
            else _project_session(session, mtime, depth, fields)
        )

    @app.get("/api/sessions/{session_id}/nodes/{node_id}")
    def get_node(session_id: str, node_id: str) -> NodeDetailOut:
        try:
            session, _ = registry.session(session_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=f"unknown session {session_id!r}") from error
        except SessionUnavailable as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        node = next((node for node in iter_nodes(session.root) if node.node_id == node_id), None)
        if node is None:
            raise HTTPException(status_code=404, detail=f"unknown node {node_id!r}")
        return node_detail_out(node)

    index_file = static_dir / "index.html"

    @app.get("/sessions/{session_id}", include_in_schema=False, response_model=None)
    def session_page(session_id: str, request: Request) -> SessionOut | JSONResponse | HTMLResponse:
        if wants_session_json(request):
            return get_session(session_id)
        html = index_file.read_text(encoding="utf-8") if index_file.is_file() else _PLACEHOLDER_PAGE
        return HTMLResponse(session_html(html, session_id), headers=_NO_CACHE)

    if index_file.is_file():

        @app.get("/{path:path}", include_in_schema=False)
        def frontend(path: str) -> FileResponse:
            if path == "api" or path.startswith("api/"):
                raise HTTPException(status_code=404, detail=f"unknown API path /{path}")
            file = static_file(static_dir, path)
            if file is not None:
                return FileResponse(file, headers=_IMMUTABLE if path.startswith(_ASSETS_PREFIX) else _NO_CACHE)
            if not path:
                return FileResponse(index_file, headers=_NO_CACHE)
            raise HTTPException(status_code=404, detail=f"unknown path /{path}")

    else:

        @app.get("/", response_class=HTMLResponse, include_in_schema=False)
        def index() -> str:
            return _PLACEHOLDER_PAGE

    return app
