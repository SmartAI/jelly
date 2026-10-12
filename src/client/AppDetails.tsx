import { useState } from "react";
import {
  ChevronRight,
  ImagePlus,
  MessageSquareText,
  Play,
  RotateCw,
  Square,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { AppRecord, AppsCapabilities } from "../shared/apps";
import type { AgentRecord, ProjectRecord } from "../shared/types";
import { appsApi } from "./api";
import { Modal } from "./Modal";
import { appException, appOrigin, safeAppOrigin } from "./app-origin";
import { AppIcon } from "./AppsHome";

const serviceIcons = { start: Play, stop: Square, restart: RotateCw };

export function AppDetails({
  app,
  capabilities,
  agents,
  projects,
  onClose,
  onAgent,
  onNewTab,
  onEdit,
  onControl,
  onRemove,
  onChanged,
}: {
  app: AppRecord;
  capabilities: AppsCapabilities | null;
  agents: AgentRecord[];
  projects: ProjectRecord[];
  onClose: () => void;
  onAgent: (id: string) => void;
  onNewTab: () => void;
  onEdit: () => void;
  onControl: (action: "start" | "stop" | "restart") => void;
  onRemove: () => void;
  onChanged: (app: AppRecord) => void;
}) {
  const [logs, setLogs] = useState<{
    text: string;
    warning: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [iconBusy, setIconBusy] = useState(false);
  const [iconError, setIconError] = useState("");
  async function uploadIcon(file: File | undefined) {
    if (!file || iconBusy) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 1024 * 1024 ||
      file.size === 0
    ) {
      setIconError(
        "Choose a PNG, JPEG, or WebP image, at most 1 MiB. SVG is not supported.",
      );
      return;
    }
    setIconBusy(true);
    setIconError("");
    try {
      onChanged(await appsApi.icon(app.id, file));
    } catch (error) {
      setIconError((error as Error).message);
    } finally {
      setIconBusy(false);
    }
  }
  const builder = agents.find((agent) => agent.id === app.builderAgentId);
  const project = projects.find((project) => project.id === app.projectId);
  async function loadLogs() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setLogs(await appsApi.logs(app.id));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function originLink(value: string | null) {
    if (!value) return <span>Unavailable</span>;
    // Apply the same origin-only checks as launch; display no query credentials.
    const safe = safeAppOrigin(value);
    if (!safe) return <span>Unavailable</span>;
    return safe === appOrigin(app) ? (
      <a
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          onNewTab();
        }}
      >
        {safe}
      </a>
    ) : (
      <code>{safe}</code>
    );
  }
  return (
    <Modal
      title={app.name}
      className="app-details apps-sheet"
      onClose={onClose}
    >
      <div className="app-details-hero">
        <AppIcon app={app} />
        <p>{app.description || "No description yet."}</p>
        <label className="app-icon-picker">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={iconBusy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void uploadIcon(file);
            }}
          />
          <span className="app-icon-picker-button">
            <ImagePlus size={16} aria-hidden="true" />
            Choose app icon
          </span>
          <small>PNG, JPEG or WebP; at most 1 MiB</small>
        </label>
        {iconBusy && <p role="status">Saving icon…</p>}
        {iconError && (
          <p role="alert" className="error-text">
            {iconError} Choose the image again to retry.
          </p>
        )}
      </div>
      <div className="app-details-quick">
        <button type="button" className="app-quick-action" onClick={onNewTab}>
          <SquareArrowOutUpRight size={20} aria-hidden="true" />
          <span>Open in new tab</span>
        </button>
        <button type="button" className="app-quick-action" onClick={onEdit}>
          <MessageSquareText size={20} aria-hidden="true" />
          <span>Edit with agent</span>
        </button>
      </div>
      <section className="settings-section">
        <h3>About</h3>
        <dl className="settings-group app-details-list">
          <div>
            <dt>Project</dt>
            <dd>
              {project?.name ??
                (app.projectId ? "Project unavailable" : "Unassigned")}
            </dd>
          </div>
          <div>
            <dt>Builder agent</dt>
            <dd>
              {builder ? (
                <button
                  className="app-text-button"
                  onClick={() => onAgent(builder.id)}
                >
                  {builder.name}
                </button>
              ) : app.builderAgentId ? (
                "Agent unavailable · app is independent"
              ) : (
                "Not linked"
              )}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd
              className={appException(app) ? "app-status-exception" : undefined}
            >
              {appException(app) ?? "Available"}
            </dd>
          </div>
          <div>
            <dt>Local URL</dt>
            <dd>{originLink(app.localOrigin)}</dd>
          </div>
          <div>
            <dt>Tailscale URL</dt>
            <dd>{originLink(app.tailnetOrigin)}</dd>
          </div>
        </dl>
      </section>
      {app.managementMode === "managed" && (
        <section className="settings-section">
          <h3>Service</h3>
          <div className="app-details-quick">
            {(["start", "stop", "restart"] as const).map((action) => {
              const Icon = serviceIcons[action];
              return (
                <button
                  key={action}
                  type="button"
                  className="app-quick-action"
                  disabled={!capabilities?.systemd}
                  onClick={() => onControl(action)}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{action[0]!.toUpperCase() + action.slice(1)}</span>
                </button>
              );
            })}
          </div>
          {!capabilities?.systemd && (
            <p className="settings-footnote">
              Service controls are unavailable or not verified on this
              instance. Inspect its capabilities and limitations before
              deploying.
            </p>
          )}
        </section>
      )}
      <details className="settings-group app-disclosure">
        <summary>
          <span>Service and diagnostics</span>
          <ChevronRight size={17} aria-hidden="true" />
        </summary>
        <div className="app-disclosure-body">
          <dl className="app-details-list">
            <div>
              <dt>Management</dt>
              <dd>{app.managementMode}</dd>
            </div>
            <div>
              <dt>Service state</dt>
              <dd>{app.observation.serviceState}</dd>
            </div>
            <div>
              <dt>HTTP health</dt>
              <dd>
                {app.observation.httpHealthy === null
                  ? "Not checked"
                  : app.observation.httpHealthy
                    ? "Healthy"
                    : "Unhealthy"}
              </dd>
            </div>
            <div>
              <dt>Checked</dt>
              <dd>
                {app.observation.checkedAt
                  ? new Date(app.observation.checkedAt).toLocaleString()
                  : "Not checked"}
              </dd>
            </div>
            <div>
              <dt>Tailnet reachability</dt>
              <dd>
                {app.observation.tailnetReachable === null
                  ? "Not verified remotely"
                  : app.observation.tailnetReachable
                    ? "Reachable"
                    : "Not reachable"}
              </dd>
            </div>
            <div>
              <dt>Unit</dt>
              <dd>{app.unitName ?? "None"}</dd>
            </div>
            <div>
              <dt>Release</dt>
              <dd>{app.deploymentRevision ?? "None"}</dd>
            </div>
          </dl>
          {app.observation.lastError && (
            <p className="error-text">{app.observation.lastError}</p>
          )}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void loadLogs()}
          >
            {busy
              ? "Loading diagnostics…"
              : logs
                ? "Refresh diagnostics"
                : "Load diagnostics"}
          </button>
          {error && (
            <p role="alert" className="error-text">
              {error}{" "}
              <button onClick={() => void loadLogs()}>Retry diagnostics</button>
            </p>
          )}
          {logs && (
            <>
              <p className="subtle">
                {logs.warning ||
                  "Diagnostics are redacted on a best-effort basis. App authors must never log secrets."}
              </p>
              <pre className="apps-logs">
                {logs.text || "No recent diagnostics."}
              </pre>
              <p className="subtle">Showing bounded recent diagnostics.</p>
            </>
          )}
        </div>
      </details>
      {!!capabilities?.warnings?.length && (
        <details className="settings-group app-disclosure">
          <summary>
            <span>Instance limitations</span>
            <ChevronRight size={17} aria-hidden="true" />
          </summary>
          <ul className="app-disclosure-body">
            {capabilities.warnings.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="settings-group app-details-remove-group">
        <button
          type="button"
          className="settings-row app-details-remove"
          onClick={onRemove}
        >
          Remove from Apps
        </button>
      </div>
    </Modal>
  );
}

export function RemoveApp({
  app,
  onClose,
  onRemoved,
}: {
  app: AppRecord;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [uninstall, setUninstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await appsApi.remove(app.id, uninstall);
      onRemoved();
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Remove ${app.name}?`}
      className="apps-sheet"
      onClose={onClose}
      dismissible={!busy}
    >
      <p className="apps-sheet-message">
        {app.managementMode === "managed"
          ? uninstall
            ? "This stops and disables the owned app and gateway services, then removes the app from Apps."
            : app.unitName
              ? "Its service will continue running, but Apps controls are lost. This app ID cannot be re-registered or later uninstalled through Apps; subsequent service cleanup is manual. Choose uninstall below if you want it stopped."
              : "This unregisters the app metadata without deleting its source or data."
          : "This only removes the link from Apps. Jelly does not own this service."}
      </p>
      {app.managementMode === "managed" && (
        <label className="apps-uninstall">
          <input
            type="checkbox"
            checked={uninstall}
            disabled={busy}
            onChange={(event) => setUninstall(event.target.checked)}
          />
          <span>Uninstall Jelly-owned service as well (stop and disable)</span>
        </label>
      )}
      <p className="subtle apps-sheet-footnote">
        Source code and app data are kept. No data is deleted.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error} Try again below.
        </p>
      )}
      <div className="apps-detail-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy
            ? "Removing…"
            : uninstall
              ? "Uninstall service and remove"
              : "Remove from Apps"}
        </button>
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
