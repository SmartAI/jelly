import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { AppRecord, AppsCapabilities } from "../shared/apps";
import { appsApi, recordAppLaunch } from "./api";
import { appException, appOrigin } from "./app-origin";
import { safeAppRoute } from "./apps-navigation";
import { AppActions } from "./AppActions";
import { AppIcon } from "./AppsHome";
import { readPreference, savePreference } from "./theme";

export type ViewerCorner = AppRecord["viewerCorner"];
const corners: ViewerCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
export function validateAppBridge(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  appId: string,
  origin: string,
  source: Window | null,
): { type: "jelly:ready" } | { type: "jelly:route"; route: string } | null {
  if (!source || event.source !== source || event.origin !== origin)
    return null;
  const data = event.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.appId !== appId
  )
    return null;
  const keys = Object.keys(data).sort().join(",");
  if (data.type === "jelly:ready" && keys === "appId,type")
    return { type: "jelly:ready" };
  if (
    data.type === "jelly:route" &&
    keys === "appId,route,type" &&
    safeAppRoute(data.route)
  )
    return { type: "jelly:route", route: data.route };
  return null;
}

export function AppViewer({
  appId,
  navigationId,
  route,
  capabilities,
  changedApp,
  revision,
  onHome,
  onChanged,
  onCapabilities,
  onRoute,
  onDetails,
  onNewTab,
  onEdit,
  onControl,
  onRemove,
}: {
  appId: string;
  navigationId: string;
  route: string;
  capabilities: AppsCapabilities | null;
  changedApp: AppRecord | null;
  revision: number;
  onHome: () => void;
  onChanged: (app: AppRecord) => void;
  onCapabilities: (capabilities: AppsCapabilities) => void;
  onRoute: (route: string) => void;
  onDetails: (app: AppRecord) => void;
  onNewTab: (app: AppRecord, navigationId: string) => void;
  onEdit: (app: AppRecord) => void;
  onControl: (app: AppRecord, action: "start" | "stop" | "restart") => void;
  onRemove: (app: AppRecord) => void;
}) {
  const [app, setApp] = useState<AppRecord | null>(null);
  const [error, setError] = useState("");
  const [launchError, setLaunchError] = useState("");
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [entryRoute] = useState(() => (safeAppRoute(route) ? route : "/"));
  const [corner, setCorner] = useState<ViewerCorner | null>(null);
  const home = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const readyAcknowledged = useRef(false);
  const callbacks = useRef({ onChanged, onRoute, onCapabilities });
  callbacks.current = { onChanged, onRoute, onCapabilities };
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
    if (!capabilities)
      void appsApi
        .capabilities()
        .then((value) => {
          if (!controller.signal.aborted)
            callbacks.current.onCapabilities(value);
        })
        .catch(() => {}); // Unknown capability stays unsupported; app recovery is still usable.
    return () => controller.abort();
  }, [appId, retry, revision]);
  useEffect(() => {
    if (changedApp?.id === appId) setApp(changedApp);
  }, [changedApp, appId]);
  useEffect(() => {
    let dead = false;
    // Entry is a visit even if unavailable. Service/HTTP polling is never a visit.
    void recordAppLaunch(appId, navigationId)
      .then((record) => {
        if (!dead) {
          setApp(record);
          callbacks.current.onChanged(record);
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
  const origin = app ? appOrigin(app) : null;
  const exceptional = app ? appException(app) : null;
  const mixed =
    !!origin &&
    window.location.protocol === "https:" &&
    origin.startsWith("http:");
  const embeddingVerified =
    !!capabilities &&
    "embedding" in capabilities &&
    capabilities.embedding === true;
  const direct =
    app?.managementMode === "linked" ||
    app?.launchMode === "direct" ||
    mixed ||
    !embeddingVerified;
  const canEmbed = !!app && !!origin && !direct && !exceptional;
  useEffect(() => {
    if (!canEmbed || !origin) return;
    readyAcknowledged.current = false;
    setReady(false);
    setFallback(false);
    setDismissed(false);
    const timeout = window.setTimeout(() => setFallback(true), 8000);
    const message = (event: MessageEvent) => {
      const valid = validateAppBridge(
        event,
        appId,
        origin,
        frame.current?.contentWindow ?? null,
      );
      if (!valid) return;
      if (valid.type === "jelly:ready") {
        setReady(true);
        setFallback(false);
        clearTimeout(timeout);
        // An SDK may reply to the viewer handshake with ready; acknowledge
        // only once per frame load, never create an unbounded message loop.
        if (!readyAcknowledged.current) {
          readyAcknowledged.current = true;
          frame.current?.contentWindow?.postMessage(
            { type: "jelly:viewer", appId },
            origin,
          );
        }
      } else callbacks.current.onRoute(valid.route);
    };
    window.addEventListener("message", message);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("message", message);
    };
  }, [appId, origin, canEmbed, retry]);
  function directLaunch() {
    if (app) onNewTab(app, navigationId);
  }
  // When Jelly can restore a stopped/failed service, that is the useful first step.
  const restoreAction =
    app?.managementMode === "managed" &&
    capabilities?.systemd &&
    app.unitName &&
    exceptional &&
    exceptional !== "Tailnet unavailable" &&
    app.desiredState !== "draft"
      ? exceptional === "Stopped"
        ? ("start" as const)
        : ("restart" as const)
      : null;
  return (
    <section
      className="app-viewer"
      aria-label={app ? `${app.name} viewer` : "App viewer"}
    >
      <div className="viewer-home-controls" data-corner={corner ?? "top-left"}>
        <button ref={home} className="viewer-home-pill" onClick={onHome}>
          <img src="/brand/jelly-mark.png" alt="" />
          Jelly home
        </button>
        {app && (
          <AppActions
            viewer
            app={app}
            onDetails={() => onDetails(app)}
            onNewTab={directLaunch}
            onEdit={() => onEdit(app)}
            onControl={(action) => onControl(app, action)}
            onRemove={() => onRemove(app)}
          >
            <div role="separator" className="apps-menu-separator" />
            <div role="group" aria-label="Jelly home position">
              <div className="apps-menu-heading" aria-hidden="true">
                Jelly home position
              </div>
              {corners.map((value) => (
                <button
                  key={value}
                  role="menuitem"
                  aria-label={`Home control ${value.replace("-", " ")}`}
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
                  <span>
                    {value[0]!.toUpperCase() + value.slice(1).replace("-", " ")}
                  </span>
                </button>
              ))}
            </div>
          </AppActions>
        )}
      </div>
      {canEmbed && (
        <iframe
          key={retry}
          ref={frame}
          title={app!.name}
          src={`${origin}${entryRoute}`}
          sandbox="allow-scripts allow-forms allow-same-origin"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; clipboard-write 'none'"
          referrerPolicy="no-referrer"
          onLoad={() => {
            // A denied/blank frame also fires load. Only a validated bridge proves readiness.
            readyAcknowledged.current = false;
            frame.current?.contentWindow?.postMessage(
              { type: "jelly:viewer", appId },
              origin!,
            );
          }}
          onError={() => setFallback(true)}
        />
      )}
      {(!canEmbed || error) && (
        <div className="viewer-recovery">
          <div className="viewer-recovery-content">
            {app ? (
              <AppIcon app={app} />
            ) : (
              <span className="viewer-recovery-placeholder" aria-hidden="true">
                {error ? (
                  <CircleAlert size={30} />
                ) : (
                  <LoaderCircle className="spin" size={28} />
                )}
              </span>
            )}
            <h1>{app?.name ?? "App unavailable"}</h1>
            {error ? (
              <p role="alert">{error}</p>
            ) : !app ? (
              <p role="status">Loading app…</p>
            ) : exceptional ? (
              <p>
                {exceptional === "Starting"
                  ? "This app is starting. Return home or retry when it is ready."
                  : exceptional === "Tailnet unavailable"
                    ? "This app is not reachable over Tailscale. Check this device's tailnet connection and access rules. Local service health does not prove remote reachability."
                    : `This app is ${exceptional.toLowerCase()}. Its place in Apps is kept.`}
              </p>
            ) : !origin ? (
              <p>
                No app address is available from this device. Local-only apps
                cannot be reached from a remote phone. Check Tailscale access or
                app details.
              </p>
            ) : mixed ? (
              <p>
                HTTPS Jelly cannot embed this HTTP app. Open it in a new tab
                instead; secure-context features require private HTTPS.
              </p>
            ) : direct ? (
              <p>
                {app.managementMode === "linked" || app.launchMode === "direct"
                  ? "This app opens directly in a new tab. Apps stays here. Jelly cannot guarantee an in-page home button on an imported app."
                  : "Embedding has not been verified by this instance. Open in a new tab for compatibility; direct access is not a cookie-isolation solution."}
              </p>
            ) : null}
            {direct && !!capabilities?.warnings?.length && (
              <ul aria-label="Instance limitations">
                {capabilities.warnings.map((limitation, index) => (
                  <li key={index}>{limitation}</li>
                ))}
              </ul>
            )}
            <div className="apps-detail-actions">
              {app && restoreAction && (
                <button
                  className="primary"
                  onClick={() => onControl(app, restoreAction)}
                >
                  {restoreAction === "start" ? "Start app" : "Restart app"}
                </button>
              )}
              {app && origin && (
                <button
                  className={restoreAction ? "secondary" : "primary"}
                  onClick={directLaunch}
                >
                  Open in new tab
                </button>
              )}
              <button
                className="secondary"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry app
              </button>
              {app && (
                <button className="secondary" onClick={() => onDetails(app)}>
                  Details
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {canEmbed && fallback && !ready && !dismissed && (
        <div className="viewer-frame-fallback" role="status">
          <p>
            App not appearing? Some apps forbid framing. A frame load does not
            confirm rendering.
          </p>
          <div className="viewer-banner-actions">
            <button className="primary" onClick={directLaunch}>
              Open in new tab
            </button>
            <button
              className="secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry frame
            </button>
            <button className="secondary" onClick={() => setDismissed(true)}>
              Keep viewing
            </button>
          </div>
        </div>
      )}
      {launchError && (
        <div className="viewer-launch-error" role="alert">
          Visit could not be saved. {launchError}{" "}
          <button
            onClick={() => {
              void recordAppLaunch(appId, navigationId)
                .then((record) => {
                  setLaunchError("");
                  callbacks.current.onChanged(record);
                })
                .catch((error) => setLaunchError((error as Error).message));
            }}
          >
            Retry recording visit
          </button>
        </div>
      )}
    </section>
  );
}
