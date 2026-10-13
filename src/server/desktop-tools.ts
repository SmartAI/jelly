import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DesktopSessions } from "./desktop-sessions";

const define = <T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition =>
  tool as ToolDefinition;
const reference = Type.String({ minLength: 1, maxLength: 100 });
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const result = (
  data: unknown,
  image?: { type: "image"; mimeType: "image/png"; data: string },
) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(data) },
    ...(image ? [image] : []),
  ],
  details: {},
});

/** Run identities come exclusively from the service/harness, never tool arguments. */
export function desktopTools(
  sessions: DesktopSessions,
  agentId: string,
  runId: string,
  requestHandoff: (reason: string, signal?: AbortSignal) => Promise<unknown>,
): ToolDefinition[] {
  const action = async (
    method: Parameters<DesktopSessions["action"]>[2],
    input: unknown,
    signal?: AbortSignal,
  ) => {
    const response = await sessions.action(
      agentId,
      runId,
      method,
      input,
      signal,
    );
    return result(response.data, response.image);
  };
  return [
    define({
      name: "desktop_status",
      label: "Desktop status",
      description:
        "Passive desktop configuration/qualification and control status. Never connects or captures.",
      parameters: object({}),
      execute: async (_id, _input, signal) => {
        signal?.throwIfAborted();
        const status = sessions.status();
        // Operator paths, raw host generations and foreign identity are not model authority.
        return result({
          enabled: status.config.enabled,
          allowedApps: status.config.allowedApps,
          captureConsent: status.config.captureConsent,
          platformSupported: status.platformSupported,
          connection: status.connection,
          control: status.control,
          ownsDesktop:
            status.owner?.agentId === agentId && status.owner.runId === runId,
          busy:
            status.owner !== null &&
            (status.owner.agentId !== agentId || status.owner.runId !== runId),
          capabilities: status.capabilities,
          permissions: status.permissions,
          reason: status.reason
            ? "Desktop is unavailable or requires recovery; inspect operator Settings. Never bypass qualification/quarantine; uncertain work blocks private credentials."
            : null,
        });
      },
    }),
    define({
      name: "desktop_apps",
      label: "Desktop apps",
      description:
        "Bounded allowed native app inventory with run-bound references. No browsers/shells/security/control apps.",
      parameters: object({}),
      execute: (_id, input, signal) => action("apps", input, signal),
    }),
    define({
      name: "desktop_windows",
      label: "Desktop windows",
      description:
        "Bounded window discovery for an exact allowed app generation. Candidates are not mutation authority; observe before input. Never frontmost or title targeting.",
      parameters: object({ appRef: reference }),
      execute: (_id, input, signal) => action("windows", input, signal),
    }),
    define({
      name: "desktop_observe",
      label: "Observe desktop window",
      description:
        "Exact-window accessibility roles with values/labels redacted. Native snapshot receipts bind subsequent input. Coverage/privacy may be unknown. Optional screenshot requires operator consent; known secure fields are refused. Images may contain sensitive content and persist in chat/model requests.",
      parameters: object({
        windowRef: reference,
        screenshot: Type.Optional(Type.Boolean()),
      }),
      execute: (_id, input, signal) => action("observe", input, signal),
    }),
    define({
      name: "desktop_click",
      label: "Click desktop element",
      description:
        "Background click on a fresh elementRef, or observationRef plus x/y image pixels from its current exact-window screenshot. Choose one target form. No foreground fallback; observe to verify, never replay uncertain input.",
      parameters: object({
        elementRef: Type.Optional(reference),
        observationRef: Type.Optional(reference),
        x: Type.Optional(Type.Number({ minimum: 0, maximum: 4096 })),
        y: Type.Optional(Type.Number({ minimum: 0, maximum: 4096 })),
      }),
      execute: (_id, input, signal) => action("click", input, signal),
    }),
    define({
      name: "desktop_type",
      label: "Type desktop text",
      description:
        "Bounded non-secret literal text into a fresh non-secure exact-window field. No clipboard, credentials or targetless typing; observe after action, never replay partial input.",
      parameters: object({
        elementRef: reference,
        text: Type.String({ minLength: 1, maxLength: 1000 }),
      }),
      execute: (_id, input, signal) => action("type", input, signal),
    }),
    define({
      name: "desktop_key",
      label: "Desktop key",
      description:
        "Fresh exact-window key: Enter, Tab, Shift+Tab, Escape, ArrowUp/Down/Left/Right, Backspace, Delete, Home, End, Space. No command/control/option/clipboard chords.",
      parameters: object({
        observationRef: reference,
        key: Type.String({ minLength: 1, maxLength: 20 }),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }),
      execute: (_id, input, signal) => action("key", input, signal),
    }),
    define({
      name: "desktop_scroll",
      label: "Desktop scroll",
      description:
        "Background scroll on a fresh exact-window elementRef. Uses the native snapshot and request-pinned scroll receipt; no global wheel events or foreground fallback.",
      parameters: object({
        elementRef: reference,
        direction: Type.Union([
          Type.Literal("up"),
          Type.Literal("down"),
          Type.Literal("left"),
          Type.Literal("right"),
        ]),
        amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      execute: (_id, input, signal) => action("scroll", input, signal),
    }),
    define({
      name: "desktop_menu",
      label: "Desktop menu (unavailable)",
      description:
        "Unavailable: the released menu MCP schema cannot consume our generation-bound snapshot reference. Use fresh background elements instead; no raw app/PID authority.",
      parameters: object({
        appRef: reference,
        action: Type.Union([Type.Literal("list"), Type.Literal("click")]),
        item: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      }),
      execute: (_id, input, signal) => action("menu", input, signal),
    }),
    define({
      name: "request_desktop_handoff",
      label: "Request desktop handoff",
      description:
        "Pause desktop automation before human/private work. Unknown accepted work blocks handoff; proxy shutdown/timeouts are not safe host completion. Only explicit operator handback can resume.",
      parameters: object({
        reason: Type.String({ minLength: 1, maxLength: 300 }),
      }),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        if (
          typeof input.reason !== "string" ||
          !input.reason.trim() ||
          input.reason.length > 300 ||
          Object.keys(input).some((key) => key !== "reason")
        )
          throw new Error("Provide only a bounded non-secret handoff reason.");
        const paused = await sessions.pauseForRun(agentId, runId);
        signal?.throwIfAborted();
        if (paused.control !== "paused")
          throw new Error(
            "Desktop handoff is unsafe: host work has not drained. Do not enter credentials or bypass quarantine.",
          );
        await requestHandoff(input.reason, signal);
        signal?.throwIfAborted();
        // Never echo an intervention payload (possibly private form data) into the model/tool timeline.
        return result({ paused: true, explicitHandbackRequired: true });
      },
    }),
  ];
}
