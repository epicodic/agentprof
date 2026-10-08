// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { truncateTitle } from "../lib/format";
import classes from "./InspectionMenu.module.css";

export interface InspectionAction {
  id: string;
  label: string;
  run: () => void;
}

export interface InspectionMenuRequest {
  x: number;
  y: number;
  actions: readonly InspectionAction[];
  returnFocus: HTMLElement | null;
}

export interface InspectionMenuApi {
  opened: boolean;
  open: (request: InspectionMenuRequest) => void;
  close: () => void;
}

const InspectionMenuContext = createContext<InspectionMenuApi | null>(null);

export function useInspectionMenu(): InspectionMenuApi {
  const value = useContext(InspectionMenuContext);
  if (value === null) throw new Error("useInspectionMenu must be used within InspectionMenuProvider");
  return value;
}

export function useInspectionMenuOptional(): InspectionMenuApi | null {
  return useContext(InspectionMenuContext);
}

function viewportPosition(request: InspectionMenuRequest, size: DOMRect): { x: number; y: number } {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(request.x, window.innerWidth - size.width - margin)),
    y: Math.max(margin, Math.min(request.y, window.innerHeight - size.height - margin)),
  };
}

function useMenuPosition(
  request: InspectionMenuRequest | null,
  menuRef: RefObject<HTMLDivElement | null>,
  setPosition: (position: { x: number; y: number }) => void,
) {
  useEffect(() => {
    const menu = menuRef.current;
    if (request === null || menu === null) return;
    setPosition(viewportPosition(request, menu.getBoundingClientRect()));
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [menuRef, request, setPosition]);
}

export function InspectionMenuProvider({ children, sourceSnapshot }: { children: ReactNode; sourceSnapshot?: object }) {
  const [request, setRequest] = useState<InspectionMenuRequest | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const sourceSnapshotRef = useRef(sourceSnapshot);
  const open = useCallback((next: InspectionMenuRequest) => setRequest(next), []);
  const close = useCallback(() => {
    const focus = request?.returnFocus;
    setRequest(null);
    requestAnimationFrame(() => {
      if (focus?.isConnected) focus.focus();
    });
  }, [request]);
  const api = useMemo<InspectionMenuApi>(() => ({ opened: request !== null, open, close }), [close, open, request]);

  useEffect(() => {
    if (sourceSnapshot === undefined) return;
    if (sourceSnapshotRef.current === sourceSnapshot) return;
    sourceSnapshotRef.current = sourceSnapshot;
    setRequest(null);
  }, [sourceSnapshot]);

  useMenuPosition(request, menuRef, setPosition);

  useEffect(() => {
    if (request === null) return;
    const outside = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setRequest(null);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [request]);

  useEffect(() => {
    const source = request?.returnFocus;
    if (source === null || source === undefined) return;
    const observer = new MutationObserver(() => {
      if (!source.isConnected) setRequest((current) => (current === request ? null : current));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [request]);

  useEffect(() => {
    if (request === null) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [close, request]);

  const menu =
    request === null
      ? null
      : createPortal(
          <div
            ref={menuRef}
            className={classes.menu}
            role="menu"
            data-mantine-stop-propagation="true"
            tabIndex={-1}
            aria-label="Inspection actions"
            style={{ left: position.x, top: position.y }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
              }
              if (event.key === "Tab") {
                setRequest(null);
                return;
              }
              const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
              if (items.length === 0) return;
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "Home") items[0].focus();
              else if (event.key === "End") items[items.length - 1].focus();
              else if (event.key === "ArrowDown") items[(index + 1) % items.length].focus();
              else if (event.key === "ArrowUp") items[(index - 1 + items.length) % items.length].focus();
              else return;
              event.preventDefault();
            }}
          >
            {request.actions.map((action) => {
              const label = truncateTitle(action.label);
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  data-mantine-stop-propagation="true"
                  className={classes.item}
                  onClick={(event) => {
                    event.stopPropagation();
                    try {
                      action.run();
                    } finally {
                      close();
                    }
                  }}
                  title={label === action.label ? undefined : action.label}
                >
                  {label}
                </button>
              );
            })}
          </div>,
          document.body,
        );

  return (
    <InspectionMenuContext.Provider value={api}>
      {children}
      {menu}
    </InspectionMenuContext.Provider>
  );
}

export function useInspectionMenuTarget(actionsFor: (target: HTMLElement) => readonly InspectionAction[]) {
  const menu = useContext(InspectionMenuContext);
  const actionsForRef = useRef(actionsFor);
  actionsForRef.current = actionsFor;
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number; target: HTMLElement } | null>(null);
  const suppressClick = useRef(false);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      start.current = null;
    },
    [],
  );
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const openAt = (x: number, y: number, target: HTMLElement) => {
    menu?.open({ x, y, actions: actionsForRef.current(target), returnFocus: target });
  };
  return {
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      openAt(event.clientX, event.clientY, event.currentTarget);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!(event.shiftKey && event.key === "F10") && event.key !== "ContextMenu") return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openAt(rect.left, rect.bottom, event.currentTarget);
    },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") return;
      clearTimer();
      const target = event.currentTarget;
      const x = event.clientX;
      const y = event.clientY;
      start.current = { x, y, target };
      timer.current = window.setTimeout(() => {
        if (start.current === null) return;
        suppressClick.current = true;
        openAt(x, y, target);
      }, 500);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const current = start.current;
      if (current === null) return;
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) {
        clearTimer();
        start.current = null;
      }
    },
    onPointerUp: () => {
      clearTimer();
      start.current = null;
    },
    onPointerCancel: () => {
      clearTimer();
      start.current = null;
    },
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
