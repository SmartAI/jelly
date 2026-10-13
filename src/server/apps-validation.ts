import { HttpError } from "./errors";
import type { AppCorner } from "../shared/apps";

export function appText(
  value: unknown,
  name: string,
  max = 200,
  empty = false,
  multiline = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(
      value,
    )
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
/** URLs are browser destinations only: never probe them from Jelly's server.
 * Queries/fragments are deliberately excluded so the registry cannot hold login tokens.
 */
export function appUrl(value: unknown, jellyOrigins: string[]): string {
  let url: URL;
  try {
    url = new URL(appText(value, "App URL", 2048));
  } catch {
    throw new HttpError(400, "Enter a valid HTTP or HTTPS app URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HttpError(
      400,
      "App URL must use HTTP(S), without credentials, query or fragment. Never store secrets in Apps.",
    );
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "Invalid app URL path.");
  }
  if (jellyOrigins.includes(url.origin) && /^\/apps(?:\/|$)/i.test(path))
    throw new HttpError(
      400,
      "Jelly's Apps viewer cannot be registered recursively.",
    );
  return url.href;
}
