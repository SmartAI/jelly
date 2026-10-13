import { useState } from "react";
import { APP_TRUST_NOTICE, type AppRecord } from "../shared/apps";
import { appsApi } from "./api";
import { Modal } from "./Modal";

export function AppRegistrationForm({
  app,
  onSaved,
}: {
  app?: AppRecord;
  onSaved: (app: AppRecord) => void;
}) {
  const [name, setName] = useState(app?.name ?? "");
  const [url, setUrl] = useState(app?.url ?? "");
  const [description, setDescription] = useState(app?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="app-registration-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          onSaved(
            await appsApi.register({
              ...(app ? { id: app.id } : {}),
              name,
              url,
              description,
            }),
          );
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Name
        <input
          required
          maxLength={100}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        App URL
        <input
          type="url"
          required
          maxLength={2048}
          placeholder="http://box.tailbfab3f.ts.net:3007"
          value={url}
          disabled={busy}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <details>
        <summary>Description (optional)</summary>
        <label>
          Description
          <textarea
            maxLength={4000}
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </details>
      <p className="settings-footnote">{APP_TRUST_NOTICE}</p>
      <p className="settings-footnote">
        Registration does not check availability. The URL must work from this
        browser; localhost on a phone means the phone. No credentials, query,
        fragment or secrets.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="apps-detail-actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : app ? "Save registration" : "Add app"}
        </button>
      </div>
    </form>
  );
}
export function AppRegistration({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (app: AppRecord) => void;
}) {
  return (
    <Modal title="Add trusted app" className="apps-sheet" onClose={onClose}>
      <AppRegistrationForm onSaved={onSaved} />
    </Modal>
  );
}
