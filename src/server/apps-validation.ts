import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { HttpError } from "./errors";
import type { AppCommand, AppCorner, AppManifest } from "../shared/apps";

export function appText(
  value: unknown,
  name: string,
  max = 200,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new HttpError(
      400,
      `${name} must be a valid ${empty ? "0" : "1"}–${max} character string.`,
    );
  return value.trim();
}
export function appId(value: unknown): string {
  const id = appText(value, "App ID", 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))
    throw new HttpError(400, "Invalid app ID.");
  return id;
}
export function appSlug(value: unknown): string {
  const slug = appText(value, "Slug", 80).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new HttpError(400, "Use a lowercase, hyphen-separated app slug.");
  return slug;
}
export function appCorner(value: unknown): AppCorner {
  if (
    !["top-left", "top-right", "bottom-left", "bottom-right"].includes(
      value as string,
    )
  )
    throw new HttpError(400, "Invalid viewer corner.");
  return value as AppCorner;
}
export function appArgs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (arg) =>
        typeof arg !== "string" || arg.length > 4096 || /[\x00\r\n]/.test(arg),
    )
  )
    throw new HttpError(
      400,
      "Arguments must be an array of literal strings (at most 100).",
    );
  if (
    value.some((arg) =>
      /^(?:--?(?:password|passwd|secret|token|api[-_]?key|authorization)(?:=|$)|(?:PASSWORD|SECRET|TOKEN|API_KEY)=)/i.test(
        arg,
      ),
    )
  )
    throw new HttpError(
      400,
      "Secrets must use private environment-file references, never command arguments.",
    );
  if (value.some((arg) => arg.includes("{port}")))
    throw new HttpError(
      400,
      "Managed runtimes require APP_SOCKET; use {socket}, not the obsolete {port} TCP substitution.",
    );
  return value as string[];
}
function absolute(value: unknown, label: string): string {
  const path = appText(value, label, 4096);
  if (!isAbsolute(path)) throw new HttpError(400, `${label} must be absolute.`);
  return resolve(path);
}
function command(value: unknown, label: string): AppCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, `${label} command is required.`);
  const input = value as Record<string, unknown>;
  return {
    executable: absolute(input.executable, `${label} executable`),
    args: appArgs(input.args),
  };
}
export function healthPath(value: unknown): string {
  const path = appText(value, "Health path", 512);
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#\\]/.test(path) ||
    path.split("/").includes("..")
  )
    throw new HttpError(
      400,
      "Health path must be a relative absolute-path without query or traversal.",
    );
  return path;
}
export function validateManifest(input: unknown): AppManifest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "A deployment manifest is required.");
  const m = input as Record<string, unknown>;
  for (const field of [
    "runtimePort",
    "runtimeSocket",
    "gatewayPort",
    "unitName",
  ])
    if (m[field] !== undefined)
      throw new HttpError(400, `${field} is server-controlled.`);
  const sourceDirectory = absolute(m.sourceDirectory, "Source directory");
  try {
    if (!statSync(sourceDirectory).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, "Source directory must exist.");
  }
  const environmentFiles =
    m.environmentFiles === undefined ? [] : m.environmentFiles;
  if (!Array.isArray(environmentFiles) || environmentFiles.length > 20)
    throw new HttpError(
      400,
      "Environment files must be an array of absolute secret-file references.",
    );
  const files = environmentFiles.map((file) =>
    absolute(file, "Environment file"),
  );
  for (const file of files) {
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.mode & 0o077) throw new Error();
      const canonical = realpathSync(file);
      if (
        canonical === realpathSync(sourceDirectory) ||
        canonical.startsWith(realpathSync(sourceDirectory) + "/")
      )
        throw new Error();
    } catch {
      throw new HttpError(
        400,
        "Environment files must exist, be private (0600), and reside outside the replaceable source directory.",
      );
    }
  }
  if (
    m.launchMode !== undefined &&
    m.launchMode !== "embedded" &&
    m.launchMode !== "direct"
  )
    throw new HttpError(400, "Invalid launch mode.");
  return {
    ...command(m, "Runtime"),
    name: appText(m.name, "Name", 100),
    sourceDirectory,
    ...(m.id === undefined ? {} : { id: appId(m.id) }),
    ...(m.slug === undefined ? {} : { slug: appSlug(m.slug) }),
    description:
      m.description === undefined
        ? ""
        : appText(m.description, "Description", 4000, true),
    ...(m.projectId === undefined ? {} : { projectId: appId(m.projectId) }),
    ...(m.builderAgentId === undefined
      ? {}
      : { builderAgentId: appId(m.builderAgentId) }),
    ...(m.build === undefined ? {} : { build: command(m.build, "Build") }),
    test: command(m.test, "Test"),
    healthPath: healthPath(m.healthPath ?? "/health"),
    launchMode: m.launchMode as AppManifest["launchMode"],
    ...(m.viewerCorner === undefined
      ? {}
      : { viewerCorner: appCorner(m.viewerCorner) }),
    environmentFiles: files,
    ...(m.migrationPlan === undefined
      ? {}
      : {
          migrationPlan: appText(
            m.migrationPlan,
            "Migration compatibility/backup plan",
            8000,
          ),
        }),
  };
}
export function privateAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const p = host.split(".").map(Number);
    return p[0] === 127 || (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127);
  }
  return (
    isIP(host) === 6 &&
    (host === "::1" || host.toLowerCase().startsWith("fd7a:115c:a1e0:"))
  );
}
export function tailnetAddress(host: string): boolean {
  return privateAddress(host) && host !== "::1" && !host.startsWith("127.");
}
export function linkedOrigin(
  value: unknown,
  jellyOrigins: string[],
): { localOrigin: string | null; tailnetOrigin: string | null } {
  let url: URL;
  try {
    url = new URL(appText(value, "Private app URL", 2048));
  } catch {
    throw new HttpError(400, "Enter a valid private app URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new HttpError(
      400,
      "Private app URL must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  const local =
    host === "localhost" || host === "::1" || host.startsWith("127.");
  if (!(
    privateAddress(host) ||
    host === "localhost" ||
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(
      host,
    )
  ))
    throw new HttpError(
      400,
      "Linked apps require a loopback or private Tailscale address, not a public/LAN URL.",
    );
  const jellyHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    ...jellyOrigins.map((origin) =>
      new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    ),
  ];
  if (
    jellyHosts.some(
      (jelly) =>
        jelly === host ||
        host.endsWith("." + jelly) ||
        jelly.endsWith("." + host),
    )
  )
    throw new HttpError(
      400,
      "Linked apps need an independent hostname and host-only cookies, distinct from Jelly regardless of port. Use managed deployment for same-host apps.",
    );
  return { localOrigin: url.origin, tailnetOrigin: local ? null : url.origin };
}
export function redactAppDiagnostics(value: string): string {
  return value
    .replace(
      /("(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"[redacted]"',
    )
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .slice(-32000);
}
