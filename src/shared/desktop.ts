// Native desktop authority is independent of browser targets. Never accept these
// operator configuration fields as model tool arguments.
export interface DesktopConfig {
  enabled: boolean;
  cliPath: string;
  hostAppPath: string;
  bridgeSocket: string;
  allowedApps: string[];
  captureConsent: boolean;
}
export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  enabled: false,
  cliPath: "",
  hostAppPath: "",
  bridgeSocket: "",
  allowedApps: [],
  captureConsent: false,
};
export type DesktopControlState =
  "active" | "paused" | "draining" | "unsafe" | "stopped";
export interface DesktopOwner {
  agentId: string;
  runId: string;
}
export interface DesktopStatus {
  config: DesktopConfig;
  platformSupported: boolean;
  connection: "disabled" | "disconnected" | "connecting" | "ready" | "blocked";
  reason: string | null;
  control: DesktopControlState;
  privateSafe: boolean;
  owner: DesktopOwner | null;
  target: { app: string; window: string } | null;
  foregroundExpiresAt: number | null;
  capabilities: {
    observe: boolean;
    images: boolean;
    click: boolean;
    type: boolean;
    key: boolean;
    scroll: boolean;
    menu: boolean;
    foreground: boolean;
  };
  host: { version: string; generation: string; identity: string } | null;
  permissions: {
    accessibility: boolean | null;
    screenRecording: boolean | null;
    syntheticInput: boolean | null;
  };
}
export interface DesktopUIStatus extends DesktopStatus {
  handoff: { id: string; agentId: string; runId: string; safe: boolean } | null;
  browserPrivate: boolean;
}
export const DESKTOP_INSTRUCTIONS = `Native Mac automation uses only desktop_* tools, separate from browser_* tools. Desktop access starts off and requires the operator's exact application grants. Prefer fresh accessibility observations and background element actions; never escalate to foreground automatically. References are run-bound and expire after mutations, compaction, handoff, or connection loss. Never repeat uncertain or partial input: observe and verify first. Tool errors do not prove no input happened. Do not enter credentials, read the clipboard, use shells/security apps, control browsers or Jelly/Peekaboo through desktop tools, or bypass these refusals with bash/MCP. Use request_desktop_handoff for private human work; wait for a confirmed safe pause and explicit handback. Screenshots may be retained in chat and sent to the selected model. Native desktop tools are unavailable to detached children. Application grants are not blanket authorization for sending, deleting, purchasing, or paying.`;
