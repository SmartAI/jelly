import { fixtureBrowserPath } from "./fixtures/browser";
import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createServer as netServer, connect } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  gatewayCookies,
  startAppGateway,
  type GatewayConfig,
} from "../scripts/app-gateway";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import {
  runtimeSocketPath,
  verifySocketParent,
} from "../src/server/apps-sockets";
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function port() {
  const server = netServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function listen(server: Server, socket?: string) {
  await new Promise<void>((resolve) =>
    socket
      ? server.listen(socket, resolve)
      : server.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return socket ? 0 : (server.address() as { port: number }).port;
}
async function rawStatus(port: number, path: string, headers = "") {
  return new Promise<number>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("data", (data) => {
      resolve(Number(data.toString().split(" ")[1]));
      socket.destroy();
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}\r\n`,
    );
  });
}
function config(
  appId: string,
  runtimeSocket = runtimeSocketPath(
    { instanceId: "gateway-fixture", appId },
    "/tmp/unused-gateway",
  ),
  gatewayPort = 33001,
): GatewayConfig {
  return {
    instanceId: "gateway-fixture",
    deploymentRevision: "fixture-release",
    appId,
    runtimeSocket,
    gatewayPort,
    cookieKey: appId === "a" ? "a".repeat(64) : "b".repeat(64),
  };
}
async function fixture(
  runtimeOverride?: string,
  launchMode: "embedded" | "direct" = "direct",
  oauthOrigin = "https://oauth.example.com",
) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-gateway-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runtimeSocket =
    runtimeOverride ??
    runtimeSocketPath(
      { instanceId: "gateway-fixture", appId: "a" },
      join(dir, "s"),
    );
  await verifySocketParent(
    runtimeSocket,
    { instanceId: "gateway-fixture", appId: "a" },
    true,
  );
  let requestCookies = "";
  let requestControl = "";
  const runtimeRequests: string[] = [];
  const runtime = createServer(async (req, res) => {
    requestCookies = req.headers.cookie ?? "";
    runtimeRequests.push(requestCookies);
    res.setHeader("x-jelly-instance-id", "runtime-spoof");
    res.setHeader("x-jelly-app-id", "runtime-spoof");
    res.setHeader("x-jelly-deployment-revision", "runtime-spoof");
    requestControl = (req.headers["x-jelly-csrf"] as string) ?? "";
    if (req.url === "/oauth/start") {
      res.writeHead(302, {
        "set-cookie": "oauth_state=fixture-state; Path=/; HttpOnly",
        location: oauthOrigin + "/authorize?state=fixture-state",
      });
      res.end();
    } else if (req.url?.startsWith("/oauth/callback")) {
      const state = new URL(req.url, "http://fixture").searchParams.get(
        "state",
      );
      const valid =
        state === "fixture-state" &&
        requestCookies.includes("oauth_state=fixture-state");
      res.writeHead(valid ? 200 : 403, {
        "content-type": "text/html",
        "set-cookie": "oauth_state=; Path=/; Max-Age=0",
      });
      res.end(
        valid
          ? "<h1>OAuth state verified</h1>"
          : "<h1>Rejected OAuth state</h1>",
      );
    } else if (req.url === "/delete") {
      res.setHeader("set-cookie", "session=; Path=/; Max-Age=0");
      res.end("deleted");
    } else if (["/cookie-error", "/cookie-redirect"].includes(req.url ?? "")) {
      res.writeHead(req.url === "/cookie-error" ? 500 : 302, {
        "set-cookie": [
          "session=changed; Path=/",
          "jelly_control=evil; Path=/api",
        ],
        ...(req.url === "/cookie-redirect" ? { location: "/deep" } : {}),
      });
      res.end("fixture");
    } else if (req.url === "/cookies") {
      res.setHeader("set-cookie", [
        "session=runtime-secret; Domain=127.0.0.1; Path=/; SameSite=None",
        "jelly_control=evil; Path=/api",
        "__Host-jelly_control=evil; Path=/",
        "session=; Path=/nested; Max-Age=0",
      ]);
      res.end("cookies");
    } else if (req.url === "/redirect") {
      res.writeHead(302, {
        location: "http://jelly-app.internal/deep?route=yes#fragment",
      });
      res.end();
    } else if (req.url?.startsWith("/unsafe-redirect")) {
      const target = req.url.split("/").at(-1);
      res.writeHead(302, {
        location:
          target === "home"
            ? "http://control.tailfixture.ts.net:5173/apps"
            : target === "control"
              ? "http://control.tailfixture.ts.net:5173/api/control-session"
              : target === "private"
                ? "http://100.64.0.123:40000/private"
                : "http://169.254.169.254/latest/meta-data",
      });
      res.end();
    } else if (req.url === "/external") {
      res.writeHead(302, { location: "https://oauth.example.com/auth" });
      res.end();
    } else if (req.url === "/stream") {
      res.write("first");
      setTimeout(() => res.end("second"), 100);
    } else if (req.url === "/upload") {
      let length = 0;
      for await (const chunk of req) length += chunk.length;
      res.end(String(length));
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          cookie: requestCookies,
          control: requestControl,
          host: req.headers.host,
          url: req.url,
        }),
      );
    }
  });
  if (!runtimeOverride) await listen(runtime, runtimeSocket);
  const gatewayPort = await port();
  const cfg = {
    ...config("a", runtimeSocket, gatewayPort),
    launchMode,
    allowedJellyOrigins: ["http://control.tailfixture.ts.net:5173"],
  };
  const errors: string[] = [];
  const gatewayPath = join(dir, "gateway.mjs");
  const networkPath = join(dir, "network.json");
  writeFileSync(
    gatewayPath,
    await (
      await Bun.build({
        entrypoints: [
          new URL("../scripts/app-gateway.ts", import.meta.url).pathname,
        ],
        target: "node",
      })
    ).outputs[0]!.text(),
    { mode: 0o600 },
  );
  writeFileSync(
    networkPath,
    JSON.stringify({ addresses: [], hostname: null }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, "runner.mjs"),
    `import {startAppGateway} from ${JSON.stringify(gatewayPath)}; import {readFile} from 'node:fs/promises'; import {createInterface} from 'node:readline';
const gateway=await startAppGateway(${JSON.stringify(cfg)},{discover:async()=>JSON.parse(await readFile(${JSON.stringify(networkPath)},'utf8')),pollMs:100000,onError:error=>console.log(JSON.stringify({error}))});
console.log(JSON.stringify({bound:gateway.boundAddresses()}));createInterface({input:process.stdin}).on('line',async()=>{await gateway.sync();console.log(JSON.stringify({bound:gateway.boundAddresses()}));});process.on('SIGTERM',()=>void gateway.close().then(()=>process.exit(0)));`,
  );
  // Production uses real Node HTTP upgrade sockets, not Bun's incompatible node:http shim.
  const child = Bun.spawn(["node", join(dir, "runner.mjs")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(async () => {
    child.kill("SIGTERM");
    await child.exited;
  });
  const reader = child.stdout.getReader();
  let buffer = "";
  const nextBound = async (): Promise<string[]> => {
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        const data = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (data.error) errors.push(data.error);
        else return data.bound;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error(
          "Node gateway exited: " + (await new Response(child.stderr).text()),
        );
      buffer += new TextDecoder().decode(chunk.value);
    }
  };
  let bound = await nextBound();
  const gateway = {
    sync: async () => {
      child.stdin.write("sync\n");
      child.stdin.flush();
      bound = await nextBound();
    },
    boundAddresses: () => bound,
  };
  const url = `http://127.0.0.1:${gatewayPort}`;
  return {
    cfg,
    runtime,
    gateway,
    gatewayPath,
    url,
    runtimeSocket,
    runtimeRequests,
    errors,
    setNetwork: (value: { addresses: string[]; hostname: string | null }) =>
      writeFileSync(networkPath, JSON.stringify(value)),
  };
}
test("cookies are authenticated per-app, HttpOnly, host-only; Jelly, other apps and JS forgeries never reach runtime", async () => {
  const f = await fixture();
  const response = await fetch(f.url + "/cookies");
  const set = response.headers.getSetCookie();
  expect(set).toHaveLength(2);
  expect(
    set.every(
      (cookie) =>
        cookie.includes("HttpOnly") &&
        !cookie.includes("Domain=") &&
        cookie.includes("SameSite=Lax"),
    ),
  ).toBe(true);
  expect(set.join(" ")).not.toContain("jelly_control");
  expect(set.join(" ")).not.toContain("runtime-secret");
  const cookie = set[0]!.split(";")[0]!;
  const b = gatewayCookies(config("b"));
  const other = b.response("session=other-secret; Path=/")!.split(";")[0]!;
  const prefix = gatewayCookies(f.cfg).prefix;
  const forged = `${prefix}${Buffer.from("session").toString("base64url")}=forged.invalid`;
  const result = await (
    await fetch(f.url + "/echo", {
      headers: {
        Cookie: `jelly_control=control-secret; unrelated=private; ${other}; ${cookie}`,
        "x-jelly-csrf": "secret-csrf",
      },
    })
  ).json();
  expect(
    (
      await fetch(f.url + "/echo", {
        headers: { cookie: `${forged}; ${cookie}` },
      })
    ).status,
  ).toBe(400);
  expect(() => gatewayCookies(f.cfg).request(`${cookie}; ${cookie}`)).toThrow(
    "Ambiguous",
  );
  expect(result.cookie).toBe("session=runtime-secret");
  expect(result.control).toBe("");
  expect(b.request(cookie)).toBeUndefined();
  expect(
    gatewayCookies(config("a", f.runtimeSocket, f.cfg.gatewayPort)).request(
      cookie,
    ),
  ).toBe("session=runtime-secret");
  expect(set[1]).toContain("Max-Age=0");
  expect(set[1]).toContain("Path=/nested");
  expect(gatewayCookies(f.cfg).request(forged)).toBeUndefined();
  const tampered = cookie.replace(/.$/, "!");
  expect(gatewayCookies(f.cfg).request(tampered)).toBeUndefined();
});
test("streaming, uploads/downloads and internal/external redirects are preserved without exposing runtime origins", async () => {
  const f = await fixture();
  const internal = await fetch(f.url + "/redirect", { redirect: "manual" });
  expect(internal.headers.get("location")).toBe(
    f.url + "/deep?route=yes#fragment",
  );
  const external = await fetch(f.url + "/external", { redirect: "manual" });
  expect(external.headers.get("location")).toBe(
    "https://oauth.example.com/auth",
  );
  const stream = await fetch(f.url + "/stream");
  const reader = stream.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("first");
  const second = await reader.read();
  expect(new TextDecoder().decode(second.value)).toBe("second");
  await reader.cancel();
  const upload = await fetch(f.url + "/upload", {
    method: "POST",
    body: "x".repeat(200000),
  });
  expect(await upload.text()).toBe("200000");
});
test("WebSocket upgrades preserve streaming and apply same strict cookies, origin and fixed upstream", async () => {
  const f = await fixture();
  const wsServer = new WebSocketServer({ server: f.runtime });
  let cookies = "";
  wsServer.on("connection", (socket, req) => {
    cookies = req.headers.cookie ?? "";
    socket.on("message", (message) => socket.send(message));
  });
  cleanups.push(() => {
    for (const socket of wsServer.clients) socket.terminate();
    return new Promise<void>((resolve) => wsServer.close(() => resolve()));
  });
  const good = gatewayCookies(f.cfg)
    .response("session=ws-secret; Path=/")!
    .split(";")[0]!;
  const ws = new WebSocket(f.url.replace("http:", "ws:") + "/socket", {
    origin: f.url,
    headers: { cookie: `jelly_control=private; ${good}` },
  });
  cleanups.push(() => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const received = new Promise<string>((resolve) =>
    ws.once("message", (message) => resolve(message.toString())),
  );
  ws.send("live websocket");
  expect(await received).toBe("live websocket");
  expect(cookies).toBe("session=ws-secret");
  ws.close();
  const rejected = await rawStatus(
    f.cfg.gatewayPort,
    "/socket",
    "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://evil.example.com\r\n",
  );
  expect(rejected).toBe(403);
});
test("gateway rejects host rebinding/arbitrary proxy destinations and recovers after tailnet disconnect/address changes", async () => {
  const f = await fixture();
  expect(
    (await fetch(f.url + "/echo", { headers: { host: "evil.example.com" } }))
      .status,
  ).toBe(403);
  const rejectedPath = await rawStatus(
    f.cfg.gatewayPort,
    "//evil.example.com/private",
    "Connection: close\r\n",
  );
  expect(rejectedPath).toBe(403);
  f.setNetwork({
    addresses: ["0.0.0.0", "192.168.1.1", "100.64.0.123"],
    hostname: "fixture.tailfixture.ts.net",
  });
  await f.gateway.sync();
  expect(f.gateway.boundAddresses()).toEqual(["127.0.0.1"]);
  expect(f.errors.some((error) => error.includes("100.64.0.123"))).toBe(true);
  f.setNetwork({ addresses: [], hostname: null });
  await f.gateway.sync();
  expect((await fetch(f.url + "/echo")).status).toBe(200);
  f.setNetwork({
    addresses: ["100.64.0.124"],
    hostname: "changed.tailfixture.ts.net",
  });
  await f.gateway.sync();
  expect(f.errors.some((error) => error.includes("100.64.0.124"))).toBe(true);
  expect(
    (
      await fetch(f.url + "/echo", {
        headers: { host: `changed.tailfixture.ts.net:${f.cfg.gatewayPort}` },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(f.url + "/echo", {
        headers: { host: `fixture.tailfixture.ts.net:${f.cfg.gatewayPort}` },
      })
    ).status,
  ).toBe(403);
});
test("invalid gateway configurations fail closed (no wildcard or raw runtime listener)", async () => {
  await expect(
    startAppGateway({ ...config("a"), cookieKey: "short" }),
  ).rejects.toThrow("configuration");
  await expect(
    startAppGateway({ ...config("a"), gatewayPort: 0 }),
  ).rejects.toThrow("configuration");
});
test("real browser cannot bypass the Unix runtime gateway to steal control cookies or forge another app's session", async () => {
  const f = await fixture();
  const browser = await chromium.launch({
    executablePath: fixtureBrowserPath(process.env.CHROME_BIN),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--host-resolver-rules=MAP *.tailfixture.ts.net 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  const b = gatewayCookies(config("b"));
  const otherPair = b
    .response("session=other-app-secret; Path=/")!
    .split(";")[0]!;
  const split = otherPair.indexOf("=");
  await context.addCookies([
    {
      name: "jelly_control",
      value: "real-control-secret",
      domain: "127.0.0.1",
      path: "/api",
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: otherPair.slice(0, split),
      value: otherPair.slice(split + 1),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  await page.goto(f.url + "/cookies");
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const stored = await context.cookies();
  expect(
    stored
      .filter((cookie) => cookie.name.startsWith("__jelly_app_"))
      .every((cookie) => cookie.httpOnly),
  ).toBe(true);
  const prefix = gatewayCookies(f.cfg).prefix;
  await page.evaluate(
    (name) => {
      document.cookie = `${name}=forged.invalid; Path=/`;
    },
    prefix + Buffer.from("injected").toString("base64url"),
  );
  const echoed = await page.evaluate(async () =>
    (await fetch("/api/echo")).json(),
  );
  expect(echoed.cookie).toBe("session=runtime-secret");
  expect(echoed.cookie).not.toContain("real-control-secret");
  expect(echoed.cookie).not.toContain("other-app-secret");
  const beforeRawAttempt = [...f.runtimeRequests];
  const rawPort = await port();
  const rawPage = await context.newPage();
  await expect(
    rawPage.goto(`http://127.0.0.1:${rawPort}/api/echo`),
  ).rejects.toThrow("ERR_CONNECTION_REFUSED");
  expect(f.runtimeRequests).toEqual(beforeRawAttempt);
  expect(
    f.runtimeRequests.every(
      (cookie) => !cookie.includes("real-control-secret"),
    ),
  ).toBe(true);
  expect(f.cfg).not.toHaveProperty("runtimePort");
  expect(
    b.request(
      stored.find((cookie) => cookie.name.startsWith(prefix))!.name +
        "=" +
        stored.find((cookie) => cookie.name.startsWith(prefix))!.value,
    ),
  ).toBeUndefined();
}, 15000);
test("real Node WebSocket handshake rewrites multiple Set-Cookie headers and rejects Jelly cookies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-ws-runtime-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runtimeSocket = runtimeSocketPath(
    { instanceId: "gateway-fixture", appId: "a" },
    join(dir, "s"),
  );
  await verifySocketParent(
    runtimeSocket,
    { instanceId: "gateway-fixture", appId: "a" },
    true,
  );
  const wsModule = new URL("../node_modules/ws/index.js", import.meta.url)
    .pathname;
  writeFileSync(
    join(dir, "runtime.cjs"),
    `const http=require('node:http');const {WebSocketServer}=require(${JSON.stringify(wsModule)});const server=http.createServer();const ws=new WebSocketServer({server});ws.on('connection',socket=>socket.on('message',(message,binary)=>socket.send(message,{binary})));ws.on('headers',(headers,request)=>headers.push('Set-Cookie: session=handshake-secret; Path=/; Domain=127.0.0.1','Set-Cookie: other=another-secret; Path=/','Set-Cookie: jelly_control=evil; Path=/api','X-Request-Cookie: '+(request.headers.cookie||'')));server.listen(${JSON.stringify(runtimeSocket)},()=>console.log('ready')); `,
  );
  const child = Bun.spawn(["node", join(dir, "runtime.cjs")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(async () => {
    child.kill();
    await child.exited;
  });
  const reader = child.stdout.getReader();
  const line = await reader.read();
  const ready = new TextDecoder().decode(line.value).trim();
  reader.releaseLock();
  if (ready !== "ready") {
    child.kill();
    throw new Error(
      "Disposable Node WS runtime failed: " +
        (await new Response(child.stderr).text()),
    );
  }
  const f = await fixture(runtimeSocket);
  const cookie = gatewayCookies(f.cfg)
    .response("session=request-secret; Path=/")!
    .split(";")[0]!;
  const handshake = await new Promise<string>((resolve, reject) => {
    const socket = connect(f.cfg.gatewayPort, "127.0.0.1");
    let received = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(received.split("\r\n\r\n")[0]!);
      }
    });
    socket.write(
      `GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${f.cfg.gatewayPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: fixture-app\r\nOrigin: ${f.url}\r\nCookie: jelly_control=private; ${cookie}\r\n\r\n`,
    );
  });
  expect(handshake).toContain("101");
  expect(handshake).toContain("x-request-cookie: session=request-secret");
  const setCookies = handshake
    .split("\r\n")
    .filter((line) => line.startsWith("set-cookie:"));
  expect(setCookies).toHaveLength(2);
  expect(
    setCookies.every(
      (line) => line.includes("HttpOnly") && !line.includes("Domain="),
    ),
  ).toBe(true);
  expect(handshake).not.toContain("jelly_control");
  expect(handshake).not.toContain("handshake-secret");
  expect(handshake).not.toContain("another-secret");
  expect(handshake).toContain("sec-websocket-protocol: fixture-app");
  const client = new WebSocket(
    f.url.replace("http:", "ws:") + "/socket",
    ["fixture-app"],
    { origin: f.url, headers: { cookie } },
  );
  cleanups.push(() => client.terminate());
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  expect(client.protocol).toBe("fixture-app");
  const echoed = new Promise<Buffer>((resolve) =>
    client.once("message", (message) =>
      resolve(Buffer.from(message as Buffer)),
    ),
  );
  client.send(Buffer.from([0, 255, 1, 128]));
  expect(await echoed).toEqual(Buffer.from([0, 255, 1, 128]));
  client.close();
  const duplicate = await rawStatus(
    f.cfg.gatewayPort,
    "/socket",
    `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${f.url}\r\nCookie: ${cookie}; ${cookie}\r\n`,
  );
  expect(duplicate).toBe(400);
});
test("redirect/error cookies and prefix/attribute ambiguities fail closed", async () => {
  const f = await fixture();
  for (const path of ["/cookie-error", "/cookie-redirect"]) {
    const response = await fetch(f.url + path, { redirect: "manual" });
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies.join()).not.toContain("jelly_control");
  }
  const policy = gatewayCookies(f.cfg);
  expect(policy.response("__Host-session=secret; Path=/")).toBeNull();
  expect(
    policy.response("__Host-session=secret; Path=/; Secure; Domain=127.0.0.1"),
  ).toBeNull();
  expect(policy.response("__Secure-session=secret; Path=/")).toBeNull();
  expect(policy.response("session=secret; Partitioned")).toBeNull();
  expect(policy.response("session=secret; Path=/; Path=/nested")).toBeNull();
  expect(policy.response("__Host-session=secret; Path=/; Secure")).toContain(
    "Secure",
  );
  expect(policy.response("session=secret; Partitioned; Secure")).toContain(
    "Partitioned",
  );
});
test("browser path/domain shadows cannot alter accepted app cookies; ambiguous namespaces rejected and logout preserved", async () => {
  const f = await fixture();
  const browser = await chromium.launch({
    executablePath: fixtureBrowserPath(process.env.CHROME_BIN),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--host-resolver-rules=MAP *.tailfixture.ts.net 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(f.url + "/cookies");
  const accepted = (await context.cookies()).find((cookie) =>
    cookie.name.startsWith(gatewayCookies(f.cfg).prefix),
  )!;
  expect(accepted.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  await page.evaluate((name) => {
    document.cookie = `${name}=forged.invalid; Path=/`;
  }, accepted.name);
  expect(
    (await context.cookies()).find(
      (cookie) => cookie.name === accepted.name && cookie.path === "/",
    )!.value,
  ).toBe(accepted.value);
  await page.evaluate((name) => {
    document.cookie = `${name}=forged.invalid; Path=/api/echo`;
  }, accepted.name);
  expect(
    await page.evaluate(async () => (await fetch("/api/echo")).status),
  ).toBe(400);
  expect(
    (await context.cookies()).find(
      (cookie) => cookie.name === accepted.name && cookie.path === "/",
    )!.value,
  ).toBe(accepted.value);
  await page.evaluate((name) => {
    document.cookie = `${name}=; Path=/api/echo; Max-Age=0`;
  }, accepted.name);
  expect(
    await page.evaluate(
      async () => (await (await fetch("/api/echo")).json()).cookie,
    ),
  ).toBe("session=runtime-secret");
  f.setNetwork({ addresses: [], hostname: "app.tailfixture.ts.net" });
  await f.gateway.sync();
  const alias = `http://app.tailfixture.ts.net:${f.cfg.gatewayPort}`;
  await page.goto(alias + "/cookies");
  const hostOnly = (await context.cookies(alias)).find(
    (cookie) => cookie.name === accepted.name,
  )!;
  expect(hostOnly.domain).toBe("app.tailfixture.ts.net");
  expect(await page.evaluate(() => document.cookie)).toBe("");
  await page.evaluate((name) => {
    document.cookie = `${name}=forged.invalid; Domain=tailfixture.ts.net; Path=/`;
  }, accepted.name);
  expect(
    await page.evaluate(async () => (await fetch("/api/echo")).status),
  ).toBe(400);
  expect(
    (await context.cookies(alias)).find(
      (cookie) =>
        cookie.name === accepted.name &&
        cookie.domain === "app.tailfixture.ts.net",
    )!.value,
  ).toBe(hostOnly.value);
  await page.evaluate((name) => {
    document.cookie = `${name}=; Domain=tailfixture.ts.net; Path=/; Max-Age=0`;
  }, accepted.name);
  expect(
    await page.evaluate(
      async () => (await (await fetch("/api/echo")).json()).cookie,
    ),
  ).toBe("session=runtime-secret");
  const replay = gatewayCookies(f.cfg)
    .response("session=runtime-secret; Path=/")!
    .split(";")[0]!
    .replace(gatewayCookies(f.cfg).prefix, gatewayCookies(config("b")).prefix);
  expect(gatewayCookies(config("b")).request(replay)).toBeUndefined();
  await page.goto(alias + "/delete");
  expect(
    (await context.cookies(alias)).find(
      (cookie) => cookie.name === accepted.name,
    ),
  ).toBeUndefined();
}, 15000);
test("redirect policy blocks Jelly control and unregistered private origins, allows configured home and explicit direct OAuth", async () => {
  const direct = await fixture();
  for (const path of [
    "/unsafe-redirect/control",
    "/unsafe-redirect/private",
    "/unsafe-redirect/metadata",
  ]) {
    const response = await fetch(direct.url + path, { redirect: "manual" });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  }
  const home = await fetch(direct.url + "/unsafe-redirect/home", {
    redirect: "manual",
  });
  expect(home.status).toBe(302);
  expect(home.headers.get("location")).toBe(
    "http://control.tailfixture.ts.net:5173/apps",
  );
  expect(
    (await fetch(direct.url + "/external", { redirect: "manual" })).status,
  ).toBe(302);
  const embedded = await fixture(undefined, "embedded");
  expect(
    (await fetch(embedded.url + "/external", { redirect: "manual" })).status,
  ).toBe(502);
});

test("real browser direct OAuth GET round-trip retains app-bound HttpOnly state; cross-origin form_post is denied", async () => {
  const tlsDir = mkdtempSync(join(tmpdir(), "jelly-fake-oauth-"));
  cleanups.push(() => rmSync(tlsDir, { recursive: true, force: true }));
  const key = join(tlsDir, "fixture.key");
  const cert = join(tlsDir, "fixture.crt");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=oauth.example.com",
      "-addext",
      "subjectAltName=DNS:oauth.example.com",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(generated.exitCode).toBe(0);
  let callbackOrigin = "";
  const idp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch: () =>
      new Response(
        `<h1>Disposable identity provider</h1><a id="callback" href="${callbackOrigin}/oauth/callback?state=fixture-state">Return with state</a><form action="${callbackOrigin}/oauth/callback" method="POST"><button>Post callback</button></form>`,
        { headers: { "content-type": "text/html" } },
      ),
  });
  cleanups.push(() => idp.stop(true));
  const f = await fixture(
    undefined,
    "direct",
    `https://oauth.example.com:${idp.port}`,
  );
  callbackOrigin = f.url;
  const browser = await chromium.launch({
    executablePath: fixtureBrowserPath(process.env.CHROME_BIN),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--host-resolver-rules=MAP oauth.example.com 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  cleanups.push(() => browser.close());
  // Only the disposable IdP certificate is self-signed; no browser isolation or mixed-content flags are disabled.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(f.url + "/oauth/start");
  await page.getByText("Disposable identity provider").waitFor();
  const stateCookie = (await context.cookies(f.url)).find((cookie) =>
    cookie.name.startsWith(gatewayCookies(f.cfg).prefix),
  )!;
  expect(stateCookie.httpOnly).toBe(true);
  expect(stateCookie.sameSite).toBe("Lax");
  await page.locator("#callback").click();
  await page.getByText("OAuth state verified").waitFor();
  expect(page.url()).toBe(f.url + "/oauth/callback?state=fixture-state");
  expect(await context.cookies(f.url)).toEqual([]);
  await page.goto(f.url + "/oauth/start");
  await page.getByRole("button", { name: "Post callback" }).click();
  await page.getByText("Unrecognized app origin or destination.").waitFor();
  expect((await context.cookies(f.url)).some((cookie) => cookie.httpOnly)).toBe(
    true,
  );
}, 15000);

test("gateway snapshots its fixed Unix upstream and never selects a destination from request input", async () => {
  const f = await fixture();
  const input = { ...f.cfg, gatewayPort: await port() };
  const gateway = await startAppGateway(input, {
    discover: async () => ({ addresses: [], hostname: null }),
    pollMs: 0,
  });
  cleanups.push(() => gateway.close());
  input.runtimeSocket = "/tmp/foreign.sock";
  const response = await fetch(
    `http://127.0.0.1:${input.gatewayPort}/echo?runtimeSocket=/tmp/foreign.sock&url=http://169.254.169.254/`,
  );
  expect(response.status).toBe(200);
  expect((await response.json()).url).toContain("/echo?runtimeSocket=");
});

test("native production Bun Unix WebSockets preserve text/binary, subprotocol and filtered handshake cookies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-bun-ws-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runtimeSocket = runtimeSocketPath(
    { instanceId: "gateway-fixture", appId: "a" },
    join(dir, "s"),
  );
  await verifySocketParent(
    runtimeSocket,
    { instanceId: "gateway-fixture", appId: "a" },
    true,
  );
  const server = Bun.serve({
    unix: runtimeSocket,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          headers: {
            "set-cookie": "session=bun-handshake; Path=/; Domain=127.0.0.1",
            "x-request-cookie": request.headers.get("cookie") ?? "",
            "sec-websocket-protocol": "fixture-app",
          },
        })
      )
        return;
      return new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const f = await fixture(runtimeSocket);
  const cookie = gatewayCookies(f.cfg)
    .response("session=app-request; Path=/")!
    .split(";")[0]!;
  const ws = new WebSocket(
    f.url.replace("http:", "ws:") + "/socket",
    "fixture-app",
    {
      headers: {
        origin: f.url,
        cookie: "jelly_control=private-control; " + cookie,
      },
    },
  );
  cleanups.push(() => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  expect(ws.protocol).toBe("fixture-app");
  // Bun's ws shim does not implement the client's upgrade event; inspect real wire headers.
  const handshake = await new Promise<string>((resolve, reject) => {
    const socket = connect(f.cfg.gatewayPort, "127.0.0.1");
    let received = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(received.split("\r\n\r\n")[0]!);
      }
    });
    socket.write(
      `GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${f.cfg.gatewayPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: fixture-app\r\nOrigin: ${f.url}\r\nCookie: jelly_control=private-control; ${cookie}\r\n\r\n`,
    );
  });
  expect(handshake).toContain("101");
  expect(handshake).toContain("x-request-cookie: session=app-request");
  expect(handshake).toContain("HttpOnly");
  expect(handshake).not.toContain("Domain=");
  expect(handshake).not.toContain("bun-handshake");
  expect(handshake).not.toContain("private-control");
  const text = new Promise<string>((resolve) =>
    ws.once("message", (value) => resolve(value.toString())),
  );
  ws.send("unix-text");
  expect(await text).toBe("unix-text");
  const bytes = new Promise<Buffer>((resolve) =>
    ws.once("message", (value) => resolve(Buffer.from(value as Buffer))),
  );
  ws.send(Buffer.from([0, 1, 255]));
  expect(await bytes).toEqual(Buffer.from([0, 1, 255]));
});

test("real loopback same-port collision rejects foreign instance/revision health and preserves the existing gateway", async () => {
  const f = await fixture();
  const { SystemAppsAdapter } = await import("../src/server/apps-runtime");
  const adapter = new SystemAppsAdapter();
  const identity = {
    instanceId: f.cfg.instanceId,
    appId: f.cfg.appId,
    deploymentRevision: f.cfg.deploymentRevision,
  };
  expect(await adapter.health(f.url, "/health", identity)).toBe(true);
  expect(
    await adapter.health(f.url, "/health", {
      ...identity,
      instanceId: "another-instance",
    }),
  ).toBe(false);
  expect(
    await adapter.health(f.url, "/health", {
      ...identity,
      appId: "another-app",
    }),
  ).toBe(false);
  expect(
    await adapter.health(f.url, "/health", {
      ...identity,
      deploymentRevision: "another-release",
    }),
  ).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), "jelly-bind-race-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const other = {
    ...f.cfg,
    instanceId: "another-instance",
    deploymentRevision: "another-release",
    runtimeSocket: runtimeSocketPath(
      { instanceId: "another-instance", appId: f.cfg.appId },
      join(dir, "s"),
    ),
  };
  await verifySocketParent(other.runtimeSocket, other, true);
  const runtime = Bun.serve({
    unix: other.runtimeSocket,
    fetch: () => Response.json({ ok: true }),
  });
  cleanups.push(() => runtime.stop(true));
  expect(await adapter.socketHealth(other.runtimeSocket, "/health")).toBe(true);
  const attempt = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `import {startAppGateway} from ${JSON.stringify(f.gatewayPath)};await startAppGateway(${JSON.stringify(other)},{discover:async()=>({addresses:[],hostname:null}),pollMs:0});`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  cleanups.push(async () => {
    if (attempt.exitCode === null) attempt.kill();
    await attempt.exited;
  });
  expect(await attempt.exited).not.toBe(0);
  expect(await new Response(attempt.stderr).text()).toContain(
    "loopback port is unavailable",
  );
  expect(await adapter.health(f.url, "/health", identity)).toBe(true);
  expect(await adapter.health(f.url, "/health", other)).toBe(false);
  const response = await fetch(f.url + "/health");
  expect(response.headers.get("x-jelly-instance-id")).toBe(identity.instanceId);
  expect(response.headers.get("x-jelly-app-id")).toBe(identity.appId);
  expect(response.headers.get("x-jelly-deployment-revision")).toBe(
    identity.deploymentRevision,
  );
});
