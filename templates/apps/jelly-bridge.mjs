// Optional app-side bridge. No credentials, commands or arbitrary return destinations cross it.
export function validRoute(route) {
  return (
    typeof route === "string" &&
    route.length <= 2048 &&
    /^\/[A-Za-z0-9/_~.-]*$/.test(route) &&
    !route.includes("//") &&
    !route.split("/").some((segment) => segment === "." || segment === "..")
  );
}

export function jellyOrigins(origins) {
  if (!Array.isArray(origins) || !origins.length || origins.length > 16)
    throw new Error("Configure exact local/tailnet Jelly origins.");
  return [
    ...new Set(
      origins.map((value) => {
        const url = new URL(value);
        const local = ["127.0.0.1", "localhost", "[::1]"].includes(
          url.hostname,
        );
        const host = url.hostname.toLowerCase();
        const ipv4 = host.split(".").map(Number);
        const tailnet =
          (ipv4.length === 4 &&
            ipv4.every(
              (part) => Number.isInteger(part) && part >= 0 && part <= 255,
            ) &&
            ipv4[0] === 100 &&
            ipv4[1] >= 64 &&
            ipv4[1] <= 127) ||
          host.startsWith("[fd7a:115c:a1e0:");
        // These aliases are injected by Jelly from Tailscale Self.HostName, not request/referrer input.
        const privateName =
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host) ||
          /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(host);
        if (
          value !== url.origin ||
          !["http:", "https:"].includes(url.protocol) ||
          (!local && !tailnet && !privateName) ||
          url.username ||
          url.password
        )
          throw new Error(
            "Jelly origins must be exact loopback or private Tailscale HTTP(S) origins.",
          );
        return url.origin;
      }),
    ),
  ];
}

export function installJellyBridge({
  appId,
  allowedOrigins,
  homeLink,
  win = window,
}) {
  if (typeof appId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(appId))
    throw new Error("Configure the server-assigned JELLY_APP_ID.");
  const origins = jellyOrigins(allowedOrigins);
  const local = (hostname) =>
    ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  const homeOrigin = origins.find(
    (origin) =>
      local(new URL(origin).hostname) === local(win.location.hostname),
  );
  homeLink.hidden = false;
  if (homeOrigin) {
    homeLink.href = `${homeOrigin}/apps`;
    homeLink.removeAttribute("aria-disabled");
  } else {
    homeLink.removeAttribute("href");
    homeLink.setAttribute("aria-disabled", "true");
    homeLink.textContent = "Jelly home unavailable here";
  }
  let viewerOrigin = null;
  const handshake = (event) => {
    const value = event.data;
    if (
      win.parent === win ||
      event.source !== win.parent ||
      !origins.includes(event.origin) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "appId,type" ||
      value.type !== "jelly:viewer" ||
      value.appId !== appId
    )
      return;
    viewerOrigin = event.origin;
    homeLink.hidden = true; // Only a validated viewer owns the always-visible outer home control.
    win.parent.postMessage({ type: "jelly:ready", appId }, viewerOrigin);
  };
  win.addEventListener("message", handshake);
  if (win.parent !== win) {
    for (const origin of origins)
      win.parent.postMessage({ type: "jelly:ready", appId }, origin);
  }
  return {
    reportRoute(route) {
      if (!viewerOrigin || !validRoute(route)) return false;
      win.parent.postMessage(
        { type: "jelly:route", appId, route },
        viewerOrigin,
      );
      return true;
    },
    close() {
      win.removeEventListener("message", handshake);
      viewerOrigin = null;
      homeLink.hidden = false;
    },
  };
}
