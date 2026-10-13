import { useEffect, useRef, useState } from "react";
import { requestId } from "./request-id";
import { readPreference, savePreference } from "./theme";

export type AppDestination = "agents" | "apps" | "viewer";
export interface AppsLocation {
  destination: AppDestination;
  appId: string | null;
  agentId: string | null;
  navigationId: string;
  focusAppId: string | null;
  explicit: boolean;
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
  return {
    location,
    navigate,
    viewer,
    navigationNotice,
    destinationReady:
      location.explicit || (!!instanceId && restored === instanceId),
  };
}

export function appFocusId(appId: string, action = "launch") {
  return `jelly-app-${encodeURIComponent(appId)}-${action}`;
}
