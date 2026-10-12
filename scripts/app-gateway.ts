/** Standalone persistent Apps gateway. Deployment copies this file to instance data;
 * deployment bundles its socket guard; it needs no worktree code or external packages. Same-host ports are NOT
 * cookie isolation: only authenticated per-app cookies pass, always HttpOnly.
 * Apps requiring document.cookie must use an independent host instead. */
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { isIP, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifySocketParent } from "../src/server/apps-sockets";
import type { AppGatewayIdentity } from "../src/shared/apps";

export interface GatewayConfig extends AppGatewayIdentity {
  runtimeSocket: string;
  gatewayPort: number;
  cookieKey: string;
  launchMode?: "embedded" | "direct";
  allowedJellyOrigins?: string[];
}
export interface GatewayNetwork {
  addresses: string[];
  hostname: string | null;
}
export interface GatewayOptions {
  discover?: () => Promise<GatewayNetwork>;
  pollMs?: number;
  onError?: (message: string) => void;
}
function tailnet(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return p[0] === 100 && p[1]! >= 64 && p[1]! <= 127;
  }
  return isIP(ip) === 6 && ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
export async function discoverGatewayNetwork(): Promise<GatewayNetwork> {
  try {
    const child = spawn("tailscale", ["status", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let raw = "";
    child.stdout.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1000000) child.kill();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (code) return { addresses: [], hostname: null };
      const status = JSON.parse(raw);
      const hostname = status.Self?.DNSName?.replace(/\.$/, "");
      return {
        addresses:
          status.BackendState === "Running" &&
          Array.isArray(status.TailscaleIPs)
            ? status.TailscaleIPs.filter(
                (ip: unknown) => typeof ip === "string" && tailnet(ip),
              )
            : [],
        hostname:
          typeof hostname === "string" &&
          /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(hostname)
            ? hostname.toLowerCase()
            : null,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { addresses: [], hostname: null };
  }
}
function reserved(name: string) {
  return /^(?:jelly[_-]|__jelly_app_|__Host-jelly|__Secure-jelly)/i.test(name);
}
const cookieToken = /^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/;
export function gatewayCookies(config: GatewayConfig) {
  const prefix = `__jelly_app_${createHash("sha256").update(config.appId).digest("hex").slice(0, 24)}_`;
  const sign = (name: string, value: string) =>
    createHmac("sha256", config.cookieKey)
      .update(name + "\0" + value)
      .digest("base64url");
  return {
    prefix,
    request(raw: string | undefined): string | undefined {
      const cookies: string[] = [];
      const names = new Set<string>();
      for (const pair of (raw ?? "").split(";")) {
        const at = pair.indexOf("=");
        if (at < 0) continue;
        const encodedName = pair.slice(0, at).trim();
        if (!encodedName.startsWith(prefix)) continue;
        // Browser Path/Domain are absent from Cookie headers. A second name can
        // be a narrower-path/domain shadow, even if one signature is invalid.
        if (names.has(encodedName))
          throw new Error("Ambiguous app cookie namespace.");
        names.add(encodedName);
        const encoded = encodedName.slice(prefix.length);
        const name = Buffer.from(encoded, "base64url").toString();
        if (
          !cookieToken.test(name) ||
          reserved(name) ||
          Buffer.from(name).toString("base64url") !== encoded
        )
          continue;
        const sealed = pair.slice(at + 1).trim();
        const dot = sealed.lastIndexOf(".");
        if (dot < 0) continue;
        const value = sealed.slice(0, dot);
        const signature = Buffer.from(sealed.slice(dot + 1));
        const expected = Buffer.from(sign(name, value));
        if (
          signature.length !== expected.length ||
          !timingSafeEqual(signature, expected)
        )
          continue;
        const decoded = Buffer.from(value, "base64url").toString();
        if (
          /[;\x00-\x20\x7f]/.test(decoded) ||
          Buffer.from(decoded).toString("base64url") !== value
        )
          continue;
        cookies.push(`${name}=${decoded}`);
      }
      return cookies.length ? cookies.join("; ") : undefined;
    },
    response(raw: string): string | null {
      const parts = raw.split(";");
      const pair = parts.shift()!;
      const at = pair.indexOf("=");
      if (at < 1) return null;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (
        !cookieToken.test(name) ||
        reserved(name) ||
        /[;\x00-\x20\x7f]/.test(value)
      )
        return null;
      const fields = parts.map((part) => part.trim());
      const count = (key: string) =>
        fields.filter((field) => field.toLowerCase().startsWith(key + "="))
          .length;
      const secure = fields.some((field) => field.toLowerCase() === "secure");
      if (
        count("path") > 1 ||
        count("domain") > 1 ||
        count("max-age") > 1 ||
        count("expires") > 1
      )
        return null;
      if (
        name.startsWith("__Host-") &&
        (!secure ||
          count("domain") > 0 ||
          !fields.some((field) => field.toLowerCase() === "path=/"))
      )
        return null;
      if (
        (name.startsWith("__Secure-") ||
          fields.some((field) => field.toLowerCase() === "partitioned")) &&
        !secure
      )
        return null;
      const encoded = Buffer.from(value).toString("base64url");
      const attributes = parts
        .map((part) => part.trim())
        .filter(
          (part) =>
            /^(?:path=|expires=|max-age=|secure$|partitioned$)/i.test(part) &&
            !/[\r\n\x00]/.test(part),
        );
      // Domain is intentionally dropped; Lax supports top-level OAuth redirects.
      // Force HttpOnly even if runtime asks otherwise, preventing cross-port theft.
      return `${prefix}${Buffer.from(name).toString("base64url")}=${encoded}.${sign(name, encoded)}; ${attributes.join("; ")}${attributes.length ? "; " : ""}HttpOnly; SameSite=Lax`;
    },
  };
}
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function cleanHeaders(headers: IncomingMessage["headers"], upgrade: boolean) {
  const forbidden = new Set([
    ...hopByHop,
    ...(headers.connection ?? "").split(",").map((v) => v.trim().toLowerCase()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        (!forbidden.has(name) ||
          (upgrade && ["connection", "upgrade"].includes(name))) &&
        !name.startsWith("x-jelly-") &&
        ![
          "cookie",
          "set-cookie",
          "forwarded",
          "x-forwarded-for",
          "x-forwarded-host",
          "x-forwarded-proto",
        ].includes(name),
    ),
  );
}
export async function startAppGateway(
  config: GatewayConfig,
  options: GatewayOptions = {},
) {
  config = Object.freeze({
    ...config,
    allowedJellyOrigins: [...(config.allowedJellyOrigins ?? [])],
  });
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(config.appId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(config.deploymentRevision) ||
    !Number.isInteger(config.gatewayPort) ||
    config.gatewayPort < 1024 ||
    config.gatewayPort > 65535 ||
    !/^[a-f0-9]{64}$/.test(config.cookieKey)
  )
    throw new Error("Invalid fixed app gateway configuration.");
  await verifySocketParent(config.runtimeSocket, {
    instanceId: config.instanceId,
    appId: config.appId,
  });
  const jellyOrigins = new Set(config.allowedJellyOrigins ?? []);
  for (const origin of jellyOrigins) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || origin !== url.origin)
      throw new Error("Invalid Jelly home origin configuration.");
  }
  if (
    config.launchMode !== undefined &&
    !["embedded", "direct"].includes(config.launchMode)
  )
    throw new Error("Invalid app launch configuration.");
  const cookies = gatewayCookies(config);
  const listeners = new Map<string, { server: Server; sockets: Set<Socket> }>();
  let network: GatewayNetwork = { addresses: [], hostname: null };
  let closed = false;
  let syncing: Promise<void> | null = null;
  const origin = (req: IncomingMessage): string | null => {
    const hosts = [
      "127.0.0.1",
      "localhost",
      ...network.addresses.map((ip) => (isIP(ip) === 6 ? `[${ip}]` : ip)),
      ...(network.hostname ? [network.hostname] : []),
    ];
    const host = req.headers.host?.toLowerCase();
    if (
      !host ||
      !hosts.some((name) => `${name}:${config.gatewayPort}` === host)
    )
      return null;
    return `http://${host}`;
  };
  const responseHeaders = (
    upstream: IncomingMessage,
    publicOrigin: string,
    upgrade: boolean,
  ) => {
    const headers = cleanHeaders(upstream.headers, upgrade);
    // Runtime x-jelly-* fields are stripped before authoritative, nonsecret identity.
    headers["x-jelly-instance-id"] = config.instanceId;
    headers["x-jelly-app-id"] = config.appId;
    headers["x-jelly-deployment-revision"] = config.deploymentRevision;
    const set = (upstream.headers["set-cookie"] ?? [])
      .map((cookie) => cookies.response(cookie))
      .filter((cookie): cookie is string => cookie !== null);
    if (set.length) headers["set-cookie"] = set;
    const location = upstream.headers.location;
    if (location) {
      try {
        const url = new URL(location, publicOrigin);
        if (url.username || url.password)
          throw new Error("Credential-bearing app redirect.");
        if (url.origin === "http://jelly-app.internal")
          headers.location =
            publicOrigin + url.pathname + url.search + url.hash;
        else if (url.origin !== publicOrigin) {
          const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
          const privateHost =
            isIP(hostname) !== 0 ||
            !hostname.includes(".") ||
            [".localhost", ".local", ".internal", ".lan", ".ts.net"].some(
              (suffix) => hostname.endsWith(suffix),
            );
          const home =
            jellyOrigins.has(url.origin) &&
            url.pathname === "/apps" &&
            !url.search &&
            !url.hash;
          if (
            !home &&
            (privateHost ||
              jellyOrigins.has(url.origin) ||
              config.launchMode !== "direct" ||
              url.protocol !== "https:")
          )
            throw new Error("Unsafe app redirect.");
        }
      } catch {
        throw new Error("Unsafe app redirect.");
      }
    }
    return headers;
  };
  const proxy = (
    req: IncomingMessage,
    res: ServerResponse | Socket,
    head?: Buffer,
  ) => {
    const publicOrigin = origin(req);
    const ws = head !== undefined;
    const fetchSite = req.headers["sec-fetch-site"];
    const crossOriginSubresource =
      ["same-site", "cross-site"].includes(String(fetchSite ?? "")) &&
      req.headers["sec-fetch-mode"] !== "navigate";
    if (
      !publicOrigin ||
      !req.url?.startsWith("/") ||
      req.url.startsWith("//") ||
      /[\r\n\\]/.test(req.url) ||
      (req.headers.origin && req.headers.origin !== publicOrigin) ||
      crossOriginSubresource
    ) {
      if (ws)
        (res as Socket).end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
        );
      else {
        (res as ServerResponse).writeHead(403);
        res.end("Unrecognized app origin or destination.");
      }
      return;
    }
    const headers = cleanHeaders(req.headers, ws);
    let cookie: string | undefined;
    try {
      cookie = cookies.request(req.headers.cookie);
    } catch {
      if (ws)
        (res as Socket).end(
          "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n",
        );
      else {
        (res as ServerResponse).writeHead(400);
        res.end(
          "Ambiguous app cookie namespace. Clear conflicting path/domain cookies and retry.",
        );
      }
      return;
    }
    if (cookie) headers.cookie = cookie;
    headers.host = req.headers.host;
    headers["x-forwarded-host"] = req.headers.host;
    headers["x-forwarded-proto"] = "http";
    const upstream = request(
      {
        socketPath: config.runtimeSocket,
        method: req.method,
        path: req.url,
        headers,
      },
      (incoming) => {
        if (ws) {
          incoming.resume();
          (res as Socket).end(
            `HTTP/1.1 ${incoming.statusCode ?? 502} Upgrade failed\r\nConnection: close\r\n\r\n`,
          );
          return;
        }
        const outgoing = res as ServerResponse;
        let filtered: ReturnType<typeof responseHeaders>;
        try {
          filtered = responseHeaders(incoming, publicOrigin, false);
        } catch {
          incoming.destroy();
          outgoing.writeHead(502);
          outgoing.end(
            "Unsafe app redirect blocked. External OAuth requires direct mode; Jelly returns must target the configured Apps home.",
          );
          return;
        }
        outgoing.writeHead(incoming.statusCode ?? 502, filtered);
        incoming.pipe(outgoing);
        incoming.on("error", () => outgoing.destroy());
        outgoing.on("close", () => incoming.destroy());
      },
    );
    upstream.on("upgrade", (incoming, socket, upstreamHead) => {
      const outgoing = res as Socket;
      let filtered: ReturnType<typeof responseHeaders>;
      try {
        filtered = responseHeaders(incoming, publicOrigin, true);
      } catch {
        socket.destroy();
        outgoing.destroy();
        return;
      }
      const lines = Object.entries(filtered).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value])
          .filter((value) => value !== undefined)
          .map((value) => `${key}: ${value}`),
      );
      outgoing.write(
        `HTTP/1.1 ${incoming.statusCode ?? 101} Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`,
      );
      if (head?.length) socket.write(head);
      if (upstreamHead.length) outgoing.write(upstreamHead);
      socket.on("error", () => outgoing.destroy());
      outgoing.on("error", () => socket.destroy());
      socket.on("close", () => outgoing.destroy());
      outgoing.on("close", () => socket.destroy());
      socket.pipe(outgoing).pipe(socket);
    });
    upstream.on("error", () => {
      if (ws) (res as Socket).destroy();
      else {
        const outgoing = res as ServerResponse;
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end("App runtime unavailable.");
      }
    });
    if (ws) {
      // Upgrade requests have no HTTP body. Hand off the socket only after the
      // upstream handshake has been filtered, rather than piping HTTP parser state.
      upstream.end();
    } else {
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    }
  };
  const listen = async (host: string) => {
    const server = createServer((req, res) => proxy(req, res));
    const sockets = new Set<Socket>();
    server.on("upgrade", (req, socket, head) =>
      proxy(req, socket as Socket, head),
    );
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) =>
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
    );
    server.requestTimeout = 0;
    server.headersTimeout = 30000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        { host, port: config.gatewayPort, ipv6Only: isIP(host) === 6 },
        () => {
          server.removeListener("error", reject);
          resolve();
        },
      );
    });
    server.on("error", () =>
      options.onError?.(
        `Gateway listener unavailable on ${host}; reconnect recovery will retry.`,
      ),
    );
    listeners.set(host, { server, sockets });
  };
  const drop = async (host: string) => {
    const listener = listeners.get(host);
    if (!listener) return;
    listeners.delete(host);
    for (const socket of listener.sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      listener.server.close(() => resolve()),
    );
  };
  const sync = () =>
    (syncing ??= (async () => {
      const discovered = await (options.discover ?? discoverGatewayNetwork)();
      if (closed) return;
      network = {
        addresses: [...new Set(discovered.addresses.filter(tailnet))],
        hostname:
          discovered.hostname &&
          /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(discovered.hostname)
            ? discovered.hostname
            : null,
      };
      const wanted = new Set(["127.0.0.1", ...network.addresses]);
      await Promise.all(
        [...listeners.keys()].filter((host) => !wanted.has(host)).map(drop),
      );
      for (const host of wanted)
        if (!listeners.has(host)) {
          try {
            await listen(host);
          } catch {
            if (host === "127.0.0.1")
              throw new Error("App gateway loopback port is unavailable.");
            options.onError?.(
              `Cannot bind private app address ${host}; retrying after reconnect.`,
            );
          }
        }
    })().finally(() => {
      syncing = null;
    }));
  await sync();
  const timer = setInterval(
    () =>
      void sync().catch(() =>
        options.onError?.("Gateway network recovery failed; will retry."),
      ),
    options.pollMs ?? 5000,
  );
  return {
    sync,
    boundAddresses: () => [...listeners.keys()],
    close: async () => {
      closed = true;
      clearInterval(timer);
      await syncing?.catch(() => {});
      await Promise.all([...listeners.keys()].map(drop));
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = JSON.parse(
    await readFile(process.argv[2] ?? "", "utf8"),
  ) as GatewayConfig;
  const gateway = await startAppGateway(config, {
    onError: (message) => console.error(message),
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => void gateway.close().then(() => process.exit(0)));
}
