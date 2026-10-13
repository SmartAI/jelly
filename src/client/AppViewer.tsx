import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { AppRecord } from "../shared/apps";
import { appsApi, recordAppLaunch } from "./api";
import { isLoopback } from "./app-origin";
import { AppActions } from "./AppActions";
import { readPreference, savePreference } from "./theme";

export type ViewerCorner = AppRecord["viewerCorner"];
const corners: ViewerCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
export function AppViewer({
  appId,
  navigationId,
  changedApp,
  revision,
  onHome,
  onChanged,
  onDetails,
  onEdit,
  onRemove,
}: {
  appId: string;
  navigationId: string;
  changedApp: AppRecord | null;
  revision: number;
  onHome: () => void;
  onChanged: (app: AppRecord) => void;
  onDetails: (app: AppRecord) => void;
  onEdit: (app: AppRecord) => void;
  onRemove: (app: AppRecord) => void;
}) {
  const [app, setApp] = useState<AppRecord | null>(null);
  const [error, setError] = useState("");
  const [launchError, setLaunchError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loadObserved, setLoadObserved] = useState(false);
  const [guidance, setGuidance] = useState(false);
  const [corner, setCorner] = useState<ViewerCorner>("top-left");
  const home = useRef<HTMLButtonElement>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    home.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void appsApi
      .get(appId, controller.signal)
      .then((record) => {
        if (controller.signal.aborted) return;
        setApp(record);
        const saved = readPreference(
          `jelly.viewer-corner.${appId}`,
          record.viewerCorner,
        );
        setCorner(
          corners.includes(saved as ViewerCorner)
            ? (saved as ViewerCorner)
            : record.viewerCorner,
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError((error as Error).message);
      });
    return () => controller.abort();
  }, [appId, revision, retry]);
  useEffect(() => {
    if (changedApp?.id === appId) setApp(changedApp);
  }, [changedApp, appId]);
  useEffect(() => {
    let dead = false;
    void recordAppLaunch(appId, navigationId)
      .then((record) => {
        if (!dead) {
          changed.current(record);
          setLaunchError("");
        }
      })
      .catch((error) => {
        if (!dead) setLaunchError((error as Error).message);
      });
    return () => {
      dead = true;
    };
  }, [appId, navigationId]);
  useLayoutEffect(() => {
    setLoadObserved(false);
  }, [app?.url, retry]);
  useEffect(() => {
    setGuidance(false);
    const timer = window.setTimeout(() => setGuidance(true), 8000);
    return () => window.clearTimeout(timer);
  }, [app?.url, retry]);
  const mixed =
    !!app &&
    window.location.protocol === "https:" &&
    new URL(app.url).protocol === "http:";
  const loopback = !!app && isLoopback(new URL(app.url).hostname);
  const help = (
    <>
      <p>
        A frame load does not prove the app rendered. Jelly cannot diagnose
        every cross-origin failure.
      </p>
      <ul>
        <li>
          Check the app is running and this device can reach its registered URL.
        </li>
        <li>
          The app's CSP frame-ancestors and X-Frame-Options must permit Jelly.
          Jelly does not bypass them.
        </li>
        <li>
          Framed sign-in and third-party-cookie restrictions may require changes
          to the app's authentication configuration.
        </li>
        <li>
          HTTPS Jelly requires an HTTPS app. Localhost on a phone means the
          phone; use a browser-reachable Tailscale URL instead.
        </li>
      </ul>
    </>
  );
  return (
    <section
      className="app-viewer"
      aria-label={app ? `${app.name} viewer` : "App viewer"}
    >
      <div className="viewer-home-controls" data-corner={corner}>
        <button ref={home} className="viewer-home-pill" onClick={onHome}>
          <img src="/brand/jelly-mark.png" alt="" />
          Back to Apps
        </button>
        {app && (
          <AppActions
            viewer
            app={app}
            onDetails={() => onDetails(app)}
            onEdit={() => onEdit(app)}
            onRemove={() => onRemove(app)}
          >
            <button role="menuitem" onClick={() => setGuidance(true)}>
              Embedding help / retry
            </button>
            <div role="separator" className="apps-menu-separator" />
            <div role="group" aria-label="Back to Apps position">
              {corners.map((value) => (
                <button
                  key={value}
                  role="menuitem"
                  aria-label={`Back control ${value.replace("-", " ")}`}
                  onClick={() => {
                    setCorner(value);
                    savePreference(`jelly.viewer-corner.${appId}`, value);
                  }}
                >
                  <Check
                    size={17}
                    aria-hidden="true"
                    style={{
                      visibility: value === corner ? "visible" : "hidden",
                    }}
                  />
                  <span>{value.replace("-", " ")}</span>
                </button>
              ))}
            </div>
          </AppActions>
        )}
      </div>
      {app && !mixed && !error && (
        <iframe
          key={`${app.url}-${retry}`}
          title={app.name}
          src={app.url}
          sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; clipboard-write 'none'"
          referrerPolicy="no-referrer"
          onLoad={() => setLoadObserved(true)}
          onError={() => setGuidance(true)}
        />
      )}
      {(!app || mixed || error) && (
        <div className="viewer-recovery">
          <div className="viewer-recovery-content">
            <h1>{app?.name ?? "App viewer"}</h1>
            <p role={error || mixed ? "alert" : "status"}>
              {error ||
                (mixed
                  ? "HTTPS Jelly cannot embed this HTTP app. Configure HTTPS hosting for the app or use HTTP Jelly on your private network."
                  : "Loading app registration…")}
            </p>
            {help}
            <div className="apps-detail-actions">
              <button
                className="secondary"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry app
              </button>
              {app && (
                <button className="secondary" onClick={() => onDetails(app)}>
                  Edit registration
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {app && !mixed && !error && guidance && (
        <div className="viewer-guidance" role="status">
          <details>
            <summary>App not appearing? Embedding help</summary>
            {help}
            {loopback && (
              <p>
                This URL uses loopback. It always refers to the device viewing
                Jelly.
              </p>
            )}
          </details>
          <p>
            {loadObserved
              ? "Frame load observed; rendering is not verified."
              : "Waiting for a frame load; the app may be unreachable or blocked."}
          </p>
          <div className="viewer-banner-actions">
            <button
              className="secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry frame
            </button>
            <button className="secondary" onClick={() => onDetails(app)}>
              Edit registration
            </button>
            <button className="secondary" onClick={() => setGuidance(false)}>
              Keep viewing
            </button>
          </div>
        </div>
      )}
      {launchError && (
        <div className="viewer-launch-error" role="alert">
          Visit could not be saved. {launchError}
          <button
            onClick={() =>
              void recordAppLaunch(appId, navigationId)
                .then((record) => {
                  changed.current(record);
                  setLaunchError("");
                })
                .catch((error) => setLaunchError((error as Error).message))
            }
          >
            Retry recording visit
          </button>
        </div>
      )}
    </section>
  );
}
