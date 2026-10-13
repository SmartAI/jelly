import { isIP } from "node:net";
import { tailnetAddresses } from "../src/shared/network";

export async function tailscaleNetwork(port: number) {
  const command = Bun.spawn(["tailscale", "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  if (code) throw new Error(`Cannot read Tailscale status: ${stderr.trim()}`);
  const status = JSON.parse(stdout) as {
    BackendState: string;
    TailscaleIPs?: string[];
    Self?: { DNSName?: string; HostName?: string };
  };
  return tailscaleOrigins(status, port);
}

/** Exact aliases from the same status document used by production startup. */
export function tailscaleOrigins(
  status: {
    BackendState: string;
    TailscaleIPs?: string[];
    Self?: { DNSName?: string; HostName?: string };
  },
  port: number,
) {
  const addresses = tailnetAddresses(status.TailscaleIPs ?? []);
  if (status.BackendState !== "Running" || !addresses.length)
    throw new Error(
      "Connect this computer to Tailscale before starting private Tailscale listeners.",
    );
  const names = [
    status.Self?.DNSName?.replace(/\.$/, ""),
    status.Self?.HostName,
  ].filter((name): name is string => !!name);
  const hosts = [
    ...new Set([
      ...names,
      ...addresses.map((ip) => (isIP(ip) === 6 ? `[${ip}]` : ip)),
    ]),
  ];
  return { addresses, origins: hosts.map((host) => `http://${host}:${port}`) };
}
