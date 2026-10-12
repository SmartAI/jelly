/** Real bootstrap/cookie transport for non-browser fixtures; no server auth bypass. */
export async function controlHeaders(
  origin: string,
  transport: typeof fetch = fetch,
) {
  const response = await transport(origin + "/api/control-session");
  if (!response.ok)
    throw new Error(`Fixture bootstrap failed: ${response.status}`);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    "x-jelly-csrf": (await response.json()).csrf as string,
  };
}
export function browserCookieFetch(
  origin: string,
  transport: typeof fetch,
): typeof fetch {
  let cookie = "";
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      origin,
    );
    const headers = new Headers(init?.headers);
    if (url.origin === origin && cookie) headers.set("cookie", cookie);
    const response = await transport(url, { ...init, headers });
    if (url.origin === origin && response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return response;
  }) as typeof fetch;
}
