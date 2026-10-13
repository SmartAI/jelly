import { createServer, type ViteDevServer } from "vite";
import { publicOrigins } from "../src/shared/network";
import { tailscaleNetwork } from "./tailscale";

const devPort = 5173;
if (Number(process.env.JELLY_PORT ?? 3100) === devPort)
  throw new Error(
    "JELLY_PORT is the API port and must differ from the dev UI port 5173. Use 3100 or leave it unset.",
  );
const tailnet =
  process.env.JELLY_TAILSCALE === "1" ? await tailscaleNetwork(devPort) : null;
const origins = [
  ...new Set([
    ...publicOrigins(process.env.JELLY_PUBLIC_ORIGINS),
    ...(tailnet?.origins ?? []),
  ]),
];
process.env.JELLY_DEV = "1";
process.env.JELLY_PUBLIC_ORIGINS = origins.join(",");
const watchApi = process.env.JELLY_WATCH_API !== "0";
console.log(
  watchApi
    ? "API auto-reload enabled: backend edits interrupt active agent runs."
    : "API auto-reload disabled: restart dev after backend changes when agents are idle.",
);
const api = Bun.spawn(
  [process.execPath, ...(watchApi ? ["--watch"] : []), "src/server/index.ts"],
  {
    // Only Vite is reachable over Tailscale in dev; its existing HTTP/WS /api proxy
    // reaches the loopback backend. No raw TCP forwarding or wildcard listener.
    env: { ...process.env, JELLY_TAILSCALE: "0" },
    stdout: "inherit",
    stderr: "inherit",
  },
);
const servers: ViteDevServer[] = [];
let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    api.kill();
    await Promise.all(servers.map((server) => server.close()));
    await api.exited;
  })());
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  for (const host of ["127.0.0.1", ...(tailnet?.addresses ?? [])]) {
    const web = await createServer({
      server: { host, port: devPort, strictPort: true },
    });
    servers.push(web);
    if (stopping) {
      await web.close();
      break;
    }
    await web.listen();
    if (stopping) {
      await web.close();
      break;
    }
  }
  if (tailnet) console.log(`Jelly over Tailscale: ${tailnet.origins[0]}`);
  const code = await api.exited;
  await stop();
  process.exit(code);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop();
  process.exit(1);
}
