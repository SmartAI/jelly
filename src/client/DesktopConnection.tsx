import { useEffect, useRef, useState } from "react";
import { Monitor } from "lucide-react";
import { api, control } from "./api";
import { ChatFormCard, ChatFormActions } from "./ChatFormCard";
import type { Intervention, Snapshot } from "../shared/types";
import {
  DEFAULT_DESKTOP_CONFIG,
  type DesktopConfig,
  type DesktopUIStatus,
} from "../shared/desktop";

export function useDesktopStatus() {
  const [status, setStatus] = useState<DesktopUIStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0),
    controlling = useRef(false),
    mounted = useRef(false);
  async function load() {
    if (controlling.current) return;
    const current = ++revision.current;
    try {
      await api("/control-session");
      const next = await api<DesktopUIStatus>("/desktop");
      if (mounted.current && current === revision.current) {
        setStatus(next);
        setError("");
      }
    } catch {
      if (mounted.current && current === revision.current) {
        setStatus(null);
        setError("Desktop status unavailable—do not enter credentials.");
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      mounted.current = false;
      ++revision.current;
      clearInterval(timer);
    };
  }, []);
  async function act(operation: string, body: Record<string, unknown> = {}) {
    if (controlling.current) return false;
    controlling.current = true;
    ++revision.current;
    setStatus(null);
    setBusy(true);
    setError("");
    try {
      await control(`/desktop/${operation}`, body);
      if (!mounted.current) return true;
      controlling.current = false;
      await load();
      return true;
    } catch (e) {
      if (mounted.current) {
        setStatus(null);
        setError(
          `Desktop control failed—do not enter credentials. ${(e as Error).message}`,
        );
      }
      return false;
    } finally {
      controlling.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { status, error, busy, act };
}

export function DesktopConnection({
  data,
  refresh,
  onDirty,
  onBusy,
}: {
  data: Snapshot;
  refresh: () => Promise<void>;
  onDirty?: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const { status, error, busy, act } = useDesktopStatus();
  const [config, setConfig] = useState<DesktopConfig>(DEFAULT_DESKTOP_CONFIG);
  const [apps, setApps] = useState("");
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const initialized = useRef(false);
  useEffect(() => {
    if (status && !initialized.current) {
      setConfig(status.config);
      setApps(status.config.allowedApps.join("\n"));
      initialized.current = true;
    }
  }, [status]);
  const change = <K extends keyof DesktopConfig>(
    key: K,
    value: DesktopConfig[K],
  ) => {
    onDirty?.(true);
    setConfig((previous) => ({ ...previous, [key]: value }));
  };
  const owner = status?.owner;
  const run = data.runs.find(
    (item) =>
      item.agentId === data.selectedAgentId && item.status === "running",
  );
  const resumeOwner =
    owner ?? (run ? { agentId: run.agentId, runId: run.id } : null);
  const ownerName =
    data.agents.find((item) => item.id === owner?.agentId)?.name ??
    owner?.agentId;
  async function action(operation: string, body: Record<string, unknown> = {}) {
    if (await act(operation, body)) {
      if (operation === "settings") onDirty?.(false);
      await refresh();
    }
  }
  const permission = (value: boolean | null | undefined) =>
    value === true ? "Granted" : value === false ? "Missing" : "Unknown";
  return (
    <section className="settings-section">
      <h3>Native Mac desktop · Peekaboo</h3>
      <p className="settings-footnote">
        Jelly’s backend must run on the Mac being controlled, with a logged-in
        GUI session and a separately installed, matching signed Peekaboo CLI and
        app. Desktop access is separate from the browser target. It starts off
        and is not a sandbox against unrestricted same-user shell or MCP access.
      </p>
      <div className="chat-form-group" aria-live="polite">
        <p>
          {status
            ? `${status.connection} · ${status.control}`
            : "Checking desktop status…"}
        </p>
        {status?.reason && <p>{status.reason}</p>}
        {status && !status.platformSupported && (
          <p>Native desktop control requires macOS 15 or later.</p>
        )}
        <p>
          {owner
            ? `Owner: ${ownerName} · run ${owner.runId}`
            : "No desktop-owning run"}
        </p>
        {status?.target && (
          <p>
            Target: {status.target.app} · {status.target.window}
          </p>
        )}
        {status?.host && (
          <p>
            Host: {status.host.identity} · {status.host.version}
          </p>
        )}
        <p>
          Accessibility: {permission(status?.permissions.accessibility)} ·
          Screen Recording: {permission(status?.permissions.screenRecording)} ·
          Synthetic input: {permission(status?.permissions.syntheticInput)}
        </p>
        {status?.browserPrivate && (
          <p>
            Private browser control blocks desktop automation. Return browser
            control explicitly before resuming desktop.
          </p>
        )}
        {status?.control === "draining" && (
          <p>Pausing—do not enter credentials yet.</p>
        )}
        {status?.control === "unsafe" && (
          <p>
            Host completion is unconfirmed—do not enter credentials. A timeout
            or closed MCP proxy does not prove the host stopped.
          </p>
        )}
      </div>
      <form
        className="chat-form-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action("settings", {
            ...config,
            allowedApps: apps.split(/\s+/).filter(Boolean),
          });
        }}
      >
        <fieldset
          disabled={busy || !initialized.current}
          className="chat-form-form"
        >
          <label className="settings-choice">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => change("enabled", e.target.checked)}
            />
            <span>Enable scoped desktop tools</span>
          </label>
          <label className="chat-form-field">
            <span>Installed CLI (absolute path)</span>
            <input
              value={config.cliPath}
              onChange={(e) => change("cliPath", e.target.value)}
              placeholder="/opt/homebrew/bin/peekaboo"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="chat-form-field">
            <span>Signed host app (absolute path)</span>
            <input
              value={config.hostAppPath}
              onChange={(e) => change("hostAppPath", e.target.value)}
              placeholder="/Applications/Peekaboo.app"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="chat-form-field">
            <span>Selected Bridge socket (absolute path)</span>
            <input
              value={config.bridgeSocket}
              onChange={(e) => change("bridgeSocket", e.target.value)}
              placeholder="/Users/you/Library/Application Support/Peekaboo/bridge.sock"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="chat-form-field">
            <span>Allowed native app bundle IDs (one per line)</span>
            <textarea
              value={apps}
              onChange={(e) => {
                onDirty?.(true);
                setApps(e.target.value);
              }}
              rows={4}
              placeholder={"com.apple.calculator\ncom.apple.TextEdit"}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="settings-choice">
            <input
              type="checkbox"
              checked={config.captureConsent}
              onChange={(e) => change("captureConsent", e.target.checked)}
            />
            <span>
              I understand exact-window screenshots can be durable chat
              attachments sent to the selected model provider.
            </span>
          </label>
          <p className="chat-form-hint">
            Disabling or stopping automation does not delete previous
            screenshots, model history, or backups. Archiving an agent is not
            deletion. See docs/PEEKABOO.md for retention and recovery.
            Accessibility filtering cannot prove every screenshot is
            secret-free. Known secure fields are refused; other sensitive
            content may still appear. Grant screenshot consent deliberately.
          </p>
          <button type="submit" className="primary">
            Save desktop settings
          </button>
        </fieldset>
      </form>
      <ChatFormActions>
        <button
          type="button"
          disabled={busy || !status?.config.enabled}
          onClick={() => void action("connect")}
        >
          Connect selected host
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void action("pause")}
        >
          Pause desktop
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void action("stop")}
        >
          Stop desktop automation
        </button>
        <button
          type="button"
          disabled={busy || !status?.privateSafe || !!status?.handoff}
          onClick={() => void action("handback")}
        >
          End private desktop work · keep automation paused
        </button>
        <button
          type="button"
          disabled={
            busy ||
            !resumeOwner ||
            !!status?.handoff ||
            !!status?.browserPrivate ||
            status?.control !== "paused"
          }
          onClick={() =>
            resumeOwner && void action("resume", { ...resumeOwner })
          }
        >
          Explicitly resume desktop
        </button>
        <button
          type="button"
          disabled={
            busy ||
            !owner ||
            !status?.capabilities.foreground ||
            status.control !== "active"
          }
          onClick={() =>
            owner && void action("foreground", { ...owner, durationMs: 30000 })
          }
        >
          Allow foreground for this run · 30 seconds
        </button>
      </ChatFormActions>
      <p className="settings-footnote">
        Stop revokes Jelly automation; it does not quit Peekaboo or target apps.
        No automatic fallback, host upgrade, daemon launch, or permission
        prompts for Bun/Node. Browsers, shells, password managers, security
        settings and Jelly/Peekaboo control surfaces are excluded. Unsupported
        operations remain unavailable until real-Mac qualification.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function DesktopHandoffCard({
  item,
  onChange,
}: {
  item: Intervention;
  onChange: () => void;
}) {
  const { status, error, busy, act } = useDesktopStatus();
  const [settled, setSettled] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const safe =
    !busy &&
    status?.handoff?.id === item.id &&
    status.handoff.runId === item.runId &&
    status.handoff.agentId === item.agentId &&
    status.handoff.safe &&
    status.privateSafe &&
    status.control === "paused";
  if (settled) return null;
  return (
    <ChatFormCard
      label="Private desktop handoff"
      title="Use the Mac directly"
      icon={<Monitor size={22} />}
      status={safe ? "Jelly automation paused" : "Preparing private handoff"}
      description={String(item.payload.reason ?? "")}
      error={error || cancelError}
    >
      <p className="chat-form-hint">
        {safe
          ? "Jelly’s accepted desktop work has drained and participating browser automation is paused. Use the Mac directly, then explicitly return control. Never enter credentials in chat. This cannot pause other applications’ automation clients."
          : "Pausing—do not enter credentials yet. Unknown host completion blocks private handoff."}
      </p>
      <ChatFormActions>
        <button
          type="button"
          className="chat-form-secondary"
          disabled={busy}
          onClick={async () => {
            try {
              await control(`/interventions/${item.id}/deny`, {});
              setSettled(true);
              onChange();
            } catch (e) {
              setCancelError((e as Error).message);
            }
          }}
        >
          Cancel request
        </button>
        <button
          type="button"
          className="primary"
          disabled={!safe}
          onClick={async () => {
            if (
              await act("resume", {
                agentId: item.agentId,
                runId: item.runId,
                handoffId: item.id,
              })
            ) {
              setSettled(true);
              onChange();
            }
          }}
        >
          Return desktop control
        </button>
      </ChatFormActions>
    </ChatFormCard>
  );
}
