import type { AppRecord, AppsPage, AppsCapabilities } from "../shared/apps";

let csrfPromise: Promise<string> | undefined;
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not reach Jelly.");
  return data as T;
}
/** Bootstrap before private reads, images and the cookie-authenticated event stream. */
export function establishControlSession(): Promise<string> {
  return (csrfPromise ??= request<{ csrf: string }>("/control-session")
    .then((value) => value.csrf)
    .catch((error) => {
      csrfPromise = undefined;
      throw error;
    }));
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  if (path === "/control-session" || path === "/health")
    return request<T>(path, options);
  const csrf = await establishControlSession();
  const headers = new Headers(options.headers);
  if (!["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase()))
    headers.set("x-jelly-csrf", csrf);
  try {
    return await request<T>(path, { ...options, headers });
  } catch (error) {
    if (
      retry &&
      /control session|control token/.test((error as Error).message)
    ) {
      csrfPromise = undefined;
      return api<T>(path, options, false);
    }
    throw error;
  }
}
export const post = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const control = <T>(path: string, data: unknown = {}) =>
  post<T>(path, data);
/** All private API operations use the same session/token, including legacy writes. */
export const projectApi = api;

export const appsApi = {
  list(
    query: { q?: string; after?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.after) params.set("after", query.after);
    if (query.limit) params.set("limit", String(query.limit));
    return api<AppsPage>(`/apps?${params}`, { signal });
  },
  get: (id: string, signal?: AbortSignal) =>
    api<AppRecord>(`/apps/${encodeURIComponent(id)}`, { signal }),
  capabilities: () => api<AppsCapabilities>("/apps/capabilities"),
  register: (input: Record<string, unknown>) =>
    control<AppRecord>("/apps/register", input),
  star: (id: string, starred: boolean) =>
    control<AppRecord>(`/apps/${encodeURIComponent(id)}/star`, { starred }),
  launch: (id: string, navigationId: string) =>
    control<AppRecord>(`/apps/${encodeURIComponent(id)}/launch`, {
      navigationId,
    }),
  remove: (id: string) => control<{ ok: true }>(`/apps/${encodeURIComponent(id)}/remove`, {}),
  icon: (id: string, file: File) =>
    projectApi<AppRecord>(`/apps/${encodeURIComponent(id)}/icon`, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    }),
};

// Viewer entry and visit retries share a navigation ID. Reload and
// StrictMode must not turn one navigation into multiple launch operations.
const appLaunches = new Map<string, Promise<AppRecord>>();
export function recordAppLaunch(id: string, navigationId: string) {
  const key = `${id}:${navigationId}`;
  let pending = appLaunches.get(key);
  if (!pending) {
    pending = appsApi.launch(id, navigationId).catch((error) => {
      appLaunches.delete(key);
      throw error;
    });
    appLaunches.set(key, pending);
    if (appLaunches.size > 256)
      appLaunches.delete(appLaunches.keys().next().value!);
  }
  return pending;
}
