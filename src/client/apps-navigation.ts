import { useEffect, useRef, useState } from "react";
import { requestId } from "./request-id";
import { readPreference, savePreference } from "./theme";

export type AppDestination = "agents" | "apps" | "viewer";
export interface AppsLocation {
  destination: AppDestination;
  appId: string | null;
  agentId: string | null;
  navigationId: string;
  route: string;
  focusAppId: string | null;
  explicit: boolean;
}

/** Bridge routes are paths, not URLs. Reject encoded separators and dot segments too. */
export function safeAppRoute(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return false;
  if (/[?#\\\s\u0000-\u001f\u007f]/.test(value)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (
    decoded !== value &&
    /[/%?#\\\s\u0000-\u001f\u007f]/.test(decoded.replaceAll("/", ""))
  )
    return false;
  // Encoded slash changes path boundaries; nested escapes can hide unsafe characters.
  if (
    /%(?:2f|5c|25)/i.test(value) ||
    /[?#\\\s\u0000-\u001f\u007f]/.test(decoded)
  )
    return false;
  return !decoded
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

export function readAppsLocation(): AppsLocation {
  const path = window.location.pathname;
  const state = window.history.state ?? {};
  const viewer = /^\/apps\/([^/]+)(\/.*)?$/.exec(path);
  const agent = /^\/agents\/([^/]+)\/?$/.exec(path);
  const queryAgent = new URLSearchParams(window.location.search).get("agentId");
  let appId: string | null = null;
  let agentId: string | null = null;
  try {
    appId = viewer ? decodeURIComponent(viewer[1]!) : null;
    agentId = agent ? decodeURIComponent(agent[1]!) : queryAgent;
  } catch {}
  const destination = appId
    ? "viewer"
    : path === "/apps" || path === "/apps/"
      ? "apps"
      : "agents";
  const navigationId =
    typeof state.jellyAppNavigationId === "string"
      ? state.jellyAppNavigationId
      : requestId();
  if (appId && state.jellyAppNavigationId !== navigationId)
    window.history.replaceState(
      { ...state, jellyAppNavigationId: navigationId },
      "",
    );
  return {
    destination,
    appId,
    agentId,
    navigationId,
    route: viewer?.[2] && safeAppRoute(viewer[2]) ? viewer[2] : "/",
    focusAppId:
      typeof state.jellyFocusAppId === "string" ? state.jellyFocusAppId : null,
    explicit:
      !!viewer ||
      path.startsWith("/agents") ||
      destination === "apps" ||
      !!queryAgent,
  };
}

export function useAppsNavigation(
  instanceId: string,
  privateSheetOpen = false,
) {
  const [location, setLocation] = useState(readAppsLocation);
  const [restored, setRestored] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const pending = useRef<{
    url: string;
    state: Record<string, unknown>;
  } | null>(null);
  const lastAgents = useRef({
    url: window.location.pathname + window.location.search,
    state: window.history.state,
  });
  if (location.destination === "agents")
    lastAgents.current = {
      url: window.location.pathname + window.location.search,
      state: window.history.state,
    };
  function defer(url: string, state: Record<string, unknown>) {
    pending.current = { url, state };
    setNavigationNotice(
      "Close Agent computer to return control safely before navigating. Your requested destination will open after handback succeeds.",
    );
  }
  useEffect(() => {
    const pop = () => {
      const next = readAppsLocation();
      if (privateSheetOpen) {
        defer(window.location.pathname, { ...window.history.state });
        window.history.replaceState(
          lastAgents.current.state,
          "",
          lastAgents.current.url,
        );
      } else setLocation(next);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [privateSheetOpen]);
  useEffect(() => {
    if (privateSheetOpen || !pending.current) return;
    const requested = pending.current;
    pending.current = null;
    setNavigationNotice("");
    window.history.pushState(requested.state, "", requested.url);
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  }, [privateSheetOpen]);
  useEffect(() => {
    if (!instanceId || restored === instanceId) return;
    setRestored(instanceId);
    if (
      !location.explicit &&
      readPreference(`jelly.destination.${instanceId}`, "agents") === "apps"
    ) {
      const next = { ...window.history.state, jellyDestination: "apps" };
      if (privateSheetOpen) defer("/apps", next);
      else {
        window.history.replaceState(next, "", "/apps");
        setLocation(readAppsLocation());
      }
    }
  }, [instanceId, restored, location.explicit, privateSheetOpen]);
  useEffect(() => {
    if (instanceId && restored === instanceId)
      savePreference(
        `jelly.destination.${instanceId}`,
        location.destination === "agents" ? "agents" : "apps",
      );
  }, [instanceId, restored, location.destination]);
  function navigate(
    destination: "agents" | "apps",
    focusAppId: string | null = null,
  ) {
    const state = destination === "agents" ? { ...window.history.state } : {};
    delete state.jellyAppNavigationId;
    delete state.jellyFocusAppId;
    const next = {
      ...state,
      jellyDestination: destination,
      jellyFocusAppId: focusAppId,
    };
    if (privateSheetOpen) {
      defer(`/${destination}`, next);
      return;
    }
    window.history.pushState(next, "", `/${destination}`);
    setLocation(readAppsLocation());
  }
  function viewer(appId: string, navigationId: string) {
    const next = {
      jellyDestination: "viewer",
      jellyAppNavigationId: navigationId,
    };
    const url = `/apps/${encodeURIComponent(appId)}`;
    if (privateSheetOpen) {
      defer(url, next);
      return;
    }
    window.history.pushState(next, "", url);
    setLocation(readAppsLocation());
  }
  function reportRoute(route: string) {
    if (!location.appId || !safeAppRoute(route)) return;
    window.history.replaceState(
      window.history.state,
      "",
      `/apps/${encodeURIComponent(location.appId)}${route === "/" ? "" : route}`,
    );
    setLocation((current) => ({ ...current, route }));
  }
  return {
    location,
    navigate,
    viewer,
    reportRoute,
    navigationNotice,
    destinationReady:
      location.explicit || (!!instanceId && restored === instanceId),
  };
}

export function appFocusId(appId: string, action = "launch") {
  return `jelly-app-${encodeURIComponent(appId)}-${action}`;
}
