import { isIP } from "node:net";

/** Exact external origins accepted through a configured local reverse proxy. */
export function publicOrigins(value = ""): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((value) => {
          const url = new URL(value);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
          )
            throw new Error(
              "JELLY_PUBLIC_ORIGINS must contain comma-separated HTTP(S) origins without paths or credentials.",
            );
          return url.origin;
        }),
    ),
  ];
}

/** Native listeners may bind discovered Tailscale IPs only, never LAN/wildcards. */
export function tailnetAddresses(addresses: string[]): string[] {
  for (const address of addresses) {
    const parts = address.split(".").map(Number);
    const v4 =
      isIP(address) === 4 &&
      parts[0] === 100 &&
      parts[1]! >= 64 &&
      parts[1]! <= 127;
    const v6 =
      isIP(address) === 6 &&
      address.toLowerCase().startsWith("fd7a:115c:a1e0:");
    if (!v4 && !v6)
      throw new Error(
        "Listeners require explicit Tailscale addresses, not LAN or wildcard addresses.",
      );
  }
  return [...new Set(addresses)];
}
