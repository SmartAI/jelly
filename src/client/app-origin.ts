import type { AppRecord } from "../shared/apps";

export function isLoopback(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function safeAppOrigin(
  candidate: string | null,
  jellyOrigin = window.location.origin,
): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.origin === jellyOrigin
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Never send a remote phone to loopback, or give app HTML Jelly's origin. */
export function appOrigin(
  app: AppRecord,
  jelly = window.location,
): string | null {
  const candidate = isLoopback(jelly.hostname)
    ? (app.localOrigin ?? app.tailnetOrigin)
    : app.tailnetOrigin;
  const origin = safeAppOrigin(candidate, jelly.origin);
  if (
    !origin ||
    (!isLoopback(jelly.hostname) && isLoopback(new URL(origin).hostname))
  )
    return null;
  return origin;
}

export function appException(app: AppRecord): string | null {
  if (
    app.desiredState === "stopped" ||
    app.observation.serviceState === "stopped"
  )
    return "Stopped";
  if (
    app.observation.serviceState === "failed" ||
    app.observation.httpHealthy === false
  )
    return "Unhealthy";
  if (
    app.desiredState === "deploying" ||
    app.observation.serviceState === "starting"
  )
    return "Starting";
  if (app.desiredState === "draft") return "Not deployed";
  if (
    !isLoopback(window.location.hostname) &&
    app.observation.tailnetReachable === false
  )
    return "Tailnet unavailable";
  return null;
}
