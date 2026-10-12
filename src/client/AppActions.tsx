import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CircleMinus,
  Ellipsis,
  Info,
  MessageSquareText,
  Play,
  RotateCw,
  Square,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { AppRecord } from "../shared/apps";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { appFocusId } from "./apps-navigation";

export function AppActions({
  app,
  onDetails,
  onNewTab,
  onEdit,
  onControl,
  onRemove,
  children,
  viewer = false,
}: {
  app: AppRecord;
  onDetails: () => void;
  onNewTab: () => void;
  onEdit: () => void;
  onControl: (action: "start" | "stop" | "restart") => void;
  onRemove: () => void;
  children?: ReactNode;
  viewer?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(open, trigger, panel, "below");
  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLElement>("button")
      ?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  function run(action: () => void) {
    close();
    action();
  }
  return (
    <>
      <button
        ref={trigger}
        id={appFocusId(app.id, viewer ? "viewer-menu" : "menu")}
        type="button"
        className="app-action"
        aria-label={`Options for ${app.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis size={20} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="apps-menu"
            role="menu"
            aria-label={`${app.name} actions`}
            onClick={(event) => {
              if ((event.target as Element).closest('button[role="menuitem"]'))
                close();
            }}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node) &&
                event.relatedTarget !== trigger.current
              )
                setOpen(false);
            }}
            onKeyDown={(event) => {
              const buttons = Array.from(
                panel.current?.querySelectorAll<HTMLElement>(
                  '[role="menuitem"]',
                ) ?? [],
              );
              const index = buttons.indexOf(
                document.activeElement as HTMLElement,
              );
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }
            }}
          >
            <button role="menuitem" onClick={() => run(onDetails)}>
              <span>Details</span>
              <Info size={18} aria-hidden="true" />
            </button>
            <button role="menuitem" onClick={() => run(onNewTab)}>
              <span>Open in new tab</span>
              <SquareArrowOutUpRight size={18} aria-hidden="true" />
            </button>
            <button role="menuitem" onClick={() => run(onEdit)}>
              <span>Edit with agent</span>
              <MessageSquareText size={18} aria-hidden="true" />
            </button>
            {app.managementMode === "managed" && (
              <>
                <div role="separator" className="apps-menu-separator" />
                <button
                  role="menuitem"
                  onClick={() => run(() => onControl("start"))}
                >
                  <span>Start</span>
                  <Play size={18} aria-hidden="true" />
                </button>
                <button
                  role="menuitem"
                  onClick={() => run(() => onControl("stop"))}
                >
                  <span>Stop</span>
                  <Square size={17} aria-hidden="true" />
                </button>
                <button
                  role="menuitem"
                  onClick={() => run(() => onControl("restart"))}
                >
                  <span>Restart</span>
                  <RotateCw size={18} aria-hidden="true" />
                </button>
              </>
            )}
            {children}
            <div role="separator" className="apps-menu-separator" />
            <button
              role="menuitem"
              className="apps-menu-destructive"
              onClick={() => run(onRemove)}
            >
              <span>Remove from Apps</span>
              <CircleMinus size={18} aria-hidden="true" />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
