import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicOrigins, tailnetAddresses } from "../src/shared/network";
import { tailscaleOrigins, tailscaleNetwork } from "../scripts/tailscale";
import { createServer as createNetServer } from "node:net";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { chromium } from "playwright-core";
import { privateDevFiles } from "../scripts/dev-files";
import { startApp } from "./fixtures/app";
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
test("Tailscale discovery produces exact HTTP aliases and rejects LAN/wildcard listeners", () => {
  const result = tailscaleOrigins(
    {
      BackendState: "Running",
      TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
      Self: { DNSName: "box.tailfixture.ts.net.", HostName: "box" },
    },
    5173,
  );
  expect(result.origins).toEqual([
    "http://box.tailfixture.ts.net:5173",
    "http://box:5173",
    "http://100.64.0.1:5173",
    "http://[fd7a:115c:a1e0::1]:5173",
  ]);
  for (const ip of [
    "0.0.0.0",
    "::",
    "127.0.0.1",
    "192.168.1.1",
    "100.128.0.1",
    "::1",
    "invalid",
  ])
    expect(() => tailnetAddresses([ip])).toThrow();
  expect(() =>
    tailscaleOrigins({ BackendState: "Stopped", TailscaleIPs: [] }, 5173),
  ).toThrow();
  expect(publicOrigins("http://box:5173, http://box:5173")).toEqual([
    "http://box:5173",
  ]);
  expect(() => publicOrigins("http://user:password@box")).toThrow();
});
let network: Awaited<ReturnType<typeof tailscaleNetwork>> | null = null;
try {
  network = await tailscaleNetwork(5173);
} catch {
  /* Portable hosts still run the deterministic policy tests. */
}
(network ? test : test.skip)(
  "startApp native loopback and discovered Tailscale HTTP listeners share state/session/SSE/WebSocket and exact origin protection",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-jelly-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const app = await startApp({
      dataDir: dir,
      configDir: join(dir, "config"),
      port: 0,
      listenAddresses: network!.addresses,
    });
    cleanups.push(() => app.close());
    expect(app.servers.map((server) => server.hostname)).toEqual([
      "127.0.0.1",
      ...network!.addresses,
    ]);
    const origins = app.servers.map((server) => server.url.origin);
    const bootstrap = await fetch(origins[0] + "/api/control-session");
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = await bootstrap.json();
    const agentId = app.store.agents()[0]!.id;
    const computer = app.service.computer.get(agentId);
    const internal = computer as unknown as {
      runtime: string | undefined;
      generation: number;
      tickets: Map<string, unknown>;
    };
    internal.runtime = join(dir, "vnc-fixture");
    mkdirSync(internal.runtime);
    const sockets = new Set<import("node:net").Socket>();
    const echo = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("data", (data) => socket.write(data));
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      echo.listen(join(internal.runtime!, "view.sock"), resolve),
    );
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => echo.close(() => resolve()));
    });
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    cleanups.push(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const origin of origins) {
      const response = await fetch(origin + "/api/state", {
        headers: { cookie, origin },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).instance.id).toBe(app.store.instance().id);
      const mutation = await fetch(origin + "/api/apps/register", {
        method: "POST",
        headers: {
          cookie,
          origin,
          "x-jelly-csrf": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Listener fixture",
          url: "http://localhost:3007",
        }),
      });
      expect(mutation.status).toBe(200);
      expect(
        (
          await fetch(origin + "/api/apps", {
            headers: { cookie, origin: "http://localhost:3007" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(origin + "/api/health", {
            headers: { host: "evil.test" },
          })
        ).status,
      ).toBe(403);
      const ticket = crypto.randomUUID();
      internal.tickets.set(ticket, {
        session: cookie.split("=")[1],
        mode: "view",
        generation: internal.generation,
        expires: Date.now() + 60000,
      });
      await context.addCookies([
        {
          url: origin + "/api",
          name: cookie.split("=")[0]!,
          value: cookie.split("=")[1]!,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      await page.goto(origin + "/api/health");
      const echoed = await page.evaluate(
        ({ agentId, ticket }) =>
          new Promise<string>((resolve, reject) => {
            const ws = new WebSocket(
              location.origin.replace("http", "ws") +
                `/api/computer/socket?agentId=${agentId}&ticket=${ticket}`,
            );
            ws.binaryType = "arraybuffer";
            ws.onopen = () =>
              ws.send(new TextEncoder().encode("native-websocket"));
            ws.onmessage = (event) => {
              resolve(new TextDecoder().decode(event.data));
              ws.close();
            };
            ws.onerror = () =>
              reject(new Error("Native WebSocket fixture failed"));
          }),
        { agentId, ticket },
      );
      expect(echoed).toBe("native-websocket");
      const controller = new AbortController();
      const stream = await fetch(
        origin + `/api/events?after=${app.store.cursor()}`,
        { headers: { cookie, origin }, signal: controller.signal },
      );
      const reader = stream.body!.getReader();
      app.service.emit(null, null, "config_changed", {
        fixture: "native-stream",
      });
      let received = "";
      while (!received.includes("native-stream")) {
        const data = await reader.read();
        if (data.done) break;
        received += new TextDecoder().decode(data.value);
      }
      expect(received).toContain("native-stream");
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  },
  20000,
);

(network ? test : test.skip)(
  "native Vite loopback/Tailscale listeners preserve SPA/private files/API streaming and HMR upgrades",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-vite-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, "web");
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), "<h1>Native Vite fixture</h1>");
    mkdirSync(join(root, ".jelly"));
    writeFileSync(
      join(root, ".jelly", "private.txt"),
      "disposable-private-marker",
    );
    const allocation = createNetServer();
    await new Promise<void>((resolve) =>
      allocation.listen(0, "127.0.0.1", resolve),
    );
    const port = (allocation.address() as { port: number }).port;
    await new Promise<void>((resolve) => allocation.close(() => resolve()));
    const hosts = ["127.0.0.1", ...network!.addresses];
    const origins = hosts.map(
      (host) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    );
    const app = await startApp({
      dataDir: join(dir, "api"),
      configDir: join(dir, "config"),
      port: 0,
      allowedOrigins: origins,
    });
    cleanups.push(() => app.close());
    // A finite disposable SSE response proves the native Vite HTTP proxy streams
    // without depending on Bun's Node-http abort/drain behavior for infinite SSE.
    const streamFixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              await Bun.sleep(25);
              controller.enqueue(
                new TextEncoder().encode("data: vite-stream\n\n"),
              );
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    cleanups.push(() => streamFixture.stop(true));
    const listeners: ViteDevServer[] = [];
    cleanups.push(() =>
      Promise.all([
        app.close(),
        ...listeners.map((listener) => listener.close()),
      ]),
    );
    for (const host of hosts) {
      const web = await createViteServer({
        configFile: false,
        root,
        plugins: [privateDevFiles()],
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          host,
          port,
          strictPort: true,
          cors: false,
          proxy: {
            "/api/stream-fixture": { target: streamFixture.url.origin },
            "/api": {
              target: app.server.url.origin,
              changeOrigin: true,
              ws: true,
            },
          },
        },
      });
      listeners.push(web);
      await web.listen();
    }
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    cleanups.push(() => browser.close());
    const page = await browser.newPage();
    for (const [index, origin] of origins.entries()) {
      expect((await fetch(origin + "/apps/fixture")).status).toBe(200);
      expect((await fetch(origin + "/.jelly/private.txt")).status).toBe(403);
      expect(
        (await fetch(origin + "/", { headers: { host: "evil.test" } })).status,
      ).toBe(403);
      const bootstrap = await fetch(origin + "/api/control-session");
      const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
      expect(
        (await fetch(origin + "/api/state", { headers: { cookie, origin } }))
          .status,
      ).toBe(200);
      expect(
        (
          await fetch(origin + "/api/state", {
            headers: { cookie, origin: "http://localhost:3007" },
          })
        ).status,
      ).toBe(403);
      const response = await fetch(origin + "/api/stream-fixture");
      const reader = response.body!.getReader();
      let data = "";
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        data += new TextDecoder().decode(part.value);
      }
      expect(data).toContain("data: first");
      expect(data).toContain("data: vite-stream");
      await page.goto(origin);
      const connected = await page.evaluate(
        (token) =>
          new Promise<string>((resolve, reject) => {
            const ws = new WebSocket(
              location.origin.replace("http", "ws") + `/?token=${token}`,
              "vite-hmr",
            );
            ws.onmessage = (event) => {
              resolve(JSON.parse(event.data).type);
              ws.close();
            };
            ws.onerror = () => reject(new Error("Native HMR fixture failed"));
          }),
        listeners[index]!.config.webSocketToken,
      );
      expect(connected).toBe("connected");
    }
  },
  20000,
);
