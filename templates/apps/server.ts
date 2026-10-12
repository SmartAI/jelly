import {
  constants,
  lstatSync,
  realpathSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { jellyOrigins } from "./jelly-bridge.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), fullscreen=()",
};

export function createApp(environment: Record<string, string | undefined>) {
  if (environment.HOST !== "127.0.0.1")
    throw new Error("HOST must be 127.0.0.1.");
  if (environment.PORT !== "0")
    throw new Error("Managed runtimes use APP_SOCKET, never a TCP PORT.");
  const socket = environment.APP_SOCKET;
  if (
    !socket ||
    !isAbsolute(socket) ||
    resolve(socket) !== socket ||
    Buffer.byteLength(socket) > 103 ||
    /[\x00-\x1f\x7f]/.test(socket)
  )
    throw new Error(
      "APP_SOCKET must be an absolute canonical Unix socket path (maximum 103 bytes).",
    );
  const socketDirectory = dirname(socket);
  const socketParent = lstatSync(socketDirectory);
  if (
    !socketParent.isDirectory() ||
    socketParent.uid !== process.getuid?.() ||
    socketParent.mode & 0o077 ||
    realpathSync(socketDirectory) !== socketDirectory
  )
    throw new Error(
      "APP_SOCKET parent must be an owned, owner-only real directory.",
    );
  try {
    lstatSync(socket);
    throw new Error(
      "APP_SOCKET already exists; the owned launcher must safely clear stale sockets.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const dataDir = environment.APP_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir))
    throw new Error("APP_DATA_DIR must be an absolute durable directory.");
  const withinSource = relative(sourceDir, resolve(dataDir));
  if (
    !withinSource ||
    (withinSource !== ".." &&
      !withinSource.startsWith(`..${sep}`) &&
      !isAbsolute(withinSource))
  )
    throw new Error("Keep APP_DATA_DIR outside replaceable source/releases.");
  const appId = environment.JELLY_APP_ID;
  if (!appId || !/^[A-Za-z0-9_-]{1,128}$/.test(appId))
    throw new Error("JELLY_APP_ID is required.");
  let origins: unknown;
  try {
    origins = JSON.parse(environment.JELLY_ALLOWED_ORIGINS ?? "");
  } catch {
    throw new Error("JELLY_ALLOWED_ORIGINS must be a JSON string array.");
  }
  if (
    !Array.isArray(origins) ||
    origins.some((origin) => typeof origin !== "string")
  )
    throw new Error("JELLY_ALLOWED_ORIGINS must be a JSON string array.");
  const allowedOrigins = jellyOrigins(origins);
  const corner = environment.JELLY_VIEWER_CORNER ?? "top-left";
  if (!corners.includes(corner))
    throw new Error("Invalid JELLY_VIEWER_CORNER.");

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dataDir).isDirectory())
    throw new Error("APP_DATA_DIR must be a real directory.");
  const notePath = join(dataDir, "note.json");
  try {
    // Exclusive creation avoids replacing existing data or following a pre-existing symlink.
    const fd = openSync(
      notePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          title: "My persistent app",
          body: "This note lives in APP_DATA_DIR, not in a release. Edit note.json locally to customize it.",
        }),
      );
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const note = () => {
    const fd = openSync(
      notePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32768)
        throw new Error("Invalid note file.");
      const text = readFileSync(fd, "utf8");
      if (text.length > 32768) throw new Error("Note too large.");
      const value: unknown = JSON.parse(text);
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as { title?: unknown }).title !== "string" ||
        typeof (value as { body?: unknown }).body !== "string"
      )
        throw new Error("Invalid note.");
      return {
        title: (value as { title: string }).title,
        body: (value as { body: string }).body,
      };
    } finally {
      closeSync(fd);
    }
  };
  note(); // Fail startup rather than claim health with unreadable/corrupt persistent data.
  const index = readFileSync(join(sourceDir, "index.html"), "utf8");
  const client = readFileSync(join(sourceDir, "client.mjs"), "utf8");
  const bridge = readFileSync(join(sourceDir, "jelly-bridge.mjs"), "utf8");
  const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${allowedOrigins.join(" ")}`;
  const response = (
    value: BodyInit | null,
    contentType: string,
    status = 200,
  ) =>
    new Response(value, {
      status,
      headers: {
        ...headers,
        "Content-Type": contentType,
        "Content-Security-Policy": csp,
      },
    });
  return {
    unix: socket,
    fetch(request: Request) {
      if (!["GET", "HEAD"].includes(request.method))
        return new Response("Method not allowed", {
          status: 405,
          headers: { ...headers, Allow: "GET, HEAD" },
        });
      const path = new URL(request.url).pathname;
      let result: Response;
      try {
        if (path === "/health") {
          note();
          result = response(JSON.stringify({ ok: true }), "application/json");
        } else if (path === "/note.json")
          result = response(JSON.stringify(note()), "application/json");
        else if (path === "/jelly-config.json")
          result = response(
            JSON.stringify({ appId, allowedOrigins, corner }),
            "application/json",
          );
        else if (path === "/client.mjs")
          result = response(client, "text/javascript");
        else if (path === "/jelly-bridge.mjs")
          result = response(bridge, "text/javascript");
        else if (path === "/" || path === "/notes")
          result = response(index, "text/html; charset=utf-8");
        else result = response("Not found", "text/plain", 404);
      } catch {
        // Never return environment values, local paths, raw errors or secrets in diagnostics.
        result = response("App data unavailable", "text/plain", 503);
      }
      return request.method === "HEAD"
        ? new Response(null, { status: result.status, headers: result.headers })
        : result;
    },
  };
}

if (import.meta.main) {
  // Production server: no watcher, dev server, shell interpolation or wildcard listener.
  const server = Bun.serve(createApp(process.env));
  console.log("App listening on its private Unix socket");
}
