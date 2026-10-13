import { useState } from "react";
import { ImagePlus, MessageSquareText } from "lucide-react";
import type { AppRecord } from "../shared/apps";
import type { AgentRecord, ProjectRecord } from "../shared/types";
import { appsApi } from "./api";
import { Modal } from "./Modal";
import { AppIcon } from "./AppsHome";
import { AppRegistrationForm } from "./AppRegistration";

export function AppDetails({
  app,
  agents,
  projects,
  onClose,
  onAgent,
  onEdit,
  onRemove,
  onChanged,
}: {
  app: AppRecord;
  agents: AgentRecord[];
  projects: ProjectRecord[];
  onClose: () => void;
  onAgent: (id: string) => void;
  onEdit: () => void;
  onRemove: () => void;
  onChanged: (app: AppRecord) => void;
}) {
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
      <section className="settings-section">
        <h3>Registration</h3>
        <AppRegistrationForm app={app} onSaved={onChanged} />
      </section>
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
            <dt>Source</dt>
            <dd>{app.sourceDirectory ?? "Not linked"}</dd>
          </div>
          <div>
            <dt>URL</dt>
            <dd>
              <code>{app.url}</code>
            </dd>
          </div>
        </dl>
        <p className="settings-footnote">
          Independently hosted. Jelly does not monitor or control this service.
        </p>
      </section>
      <div className="app-details-quick">
        <button type="button" className="app-quick-action" onClick={onEdit}>
          <MessageSquareText size={20} aria-hidden="true" />
          <span>Edit with agent</span>
        </button>
      </div>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={`Remove ${app.name}?`}
      className="apps-sheet"
      onClose={onClose}
      dismissible={!busy}
    >
      <p className="apps-sheet-message">
        This unregisters the app and removes its stars and visit history from
        Jelly. Its independent service keeps running. Source code and app data
        are not changed.
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
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await appsApi.remove(app.id);
              onRemoved();
            } catch (error) {
              setError((error as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? "Removing…" : "Remove from Apps"}
        </button>
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
