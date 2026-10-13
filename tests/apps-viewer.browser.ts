import { chromium } from "playwright-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./fixtures/app";
const dir = mkdtempSync(join(tmpdir(), "trusted-apps-browser-"));
const jelly = await startApp({
  dataDir: dir,
  configDir: join(dir, "config"),
  port: 0,
});
const origin = jelly.server.url.origin;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
let sameHostCookieSeen = false;
const appServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/socket" && server.upgrade(request)) return;
    if (path === "/api/sharing") {
      sameHostCookieSeen = /(?:^|;\s*)jelly_control=/.test(
        request.headers.get("cookie") ?? "",
      );
      return Response.json({ sawCookie: sameHostCookieSeen });
    }
    if (path === "/stream")
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first "));
            await Bun.sleep(50);
            controller.enqueue(new TextEncoder().encode("last"));
            controller.close();
          },
        }),
      );
    if (path === "/denied-xfo")
      return new Response("XFO blocked", {
        headers: { "content-type": "text/html", "x-frame-options": "DENY" },
      });
    if (path === "/denied-csp")
      return new Response("CSP blocked", {
        headers: {
          "content-type": "text/html",
          "content-security-policy": "frame-ancestors 'none'",
        },
      });
    if (path === "/auth")
      return new Response("<h1>Framed sign-in needs app configuration</h1>", {
        status: 401,
        headers: { "content-type": "text/html" },
      });
    if (path === "/form")
      return new Response(
        `<h1>Form submitted: ${new URLSearchParams(await request.text()).get("value")}</h1>`,
        { headers: { "content-type": "text/html" } },
      );
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="padding:90px 16px;font:16px system-ui"><h1>Trusted fixture</h1><p id="script">Script pending</p><p id="socket">Socket pending</p><p id="stream">Stream pending</p><p id="control">Control pending</p><p id="restrictions"></p><form method="post" action="/form"><label>Value<input name="value" value="works"></label><button>Submit form</button></form><a href="/internal/report">Internal report</a><button id="escape">Try top navigation and popup</button><script>
      document.querySelector('#script').textContent='Scripts work';
      const ws=new WebSocket(location.origin.replace('http','ws')+'/socket'); ws.onopen=()=>ws.send('echo'); ws.onmessage=e=>document.querySelector('#socket').textContent='WebSocket '+e.data;
      fetch('/stream').then(r=>r.text()).then(text=>document.querySelector('#stream').textContent='Streaming '+text);
      fetch('/api/sharing');
      fetch(${JSON.stringify(origin + "/api/state")},{credentials:'include'}).then(()=>document.querySelector('#control').textContent='Unexpected API access').catch(()=>document.querySelector('#control').textContent='Control API blocked');
      document.querySelector('#escape').onclick=()=>{ let topDenied=false,popupDenied=false; try { top.location.href=${JSON.stringify(origin + "/escaped")}; } catch {topDenied=true;} try {popupDenied=window.open('/popup')===null;} catch {popupDenied=true;} document.querySelector('#restrictions').textContent=JSON.stringify({topDenied,popupDenied}); };
    </script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
  websocket: {
    message(socket, message) {
      socket.send(message);
    },
  },
});
const registered = jelly.service.apps.register({
  name: "Trusted fixture",
  url: appServer.url.origin + "/dashboard",
});
jelly.service.apps.setStarred(registered.id, true);
const blocked = ["denied-xfo", "denied-csp", "auth"].map((path) =>
  jelly.service.apps.register({
    name: path,
    url: appServer.url.origin + "/" + path,
  }),
);
for (let index = 0; index < 35; index++)
  jelly.service.apps.register({
    name: `History ${index}`,
    url: appServer.url.origin + "/dashboard",
  });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
});
let proxy: ReturnType<typeof Bun.serve> | undefined;
try {
  for (const width of [1280, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 780 },
    });
    const page = await context.newPage();
    let popups = 0;
    page.on("popup", () => popups++);
    await page.goto(origin + "/apps");
    const launch = page.getByRole("button", {
      name: "Open Trusted fixture",
      exact: true,
    });
    await launch.waitFor();
    const scroller = page.locator(".apps-home");
    await scroller.evaluate((element) => {
      element.scrollTop = 240;
    });
    await launch.click({ force: true });
    await page.waitForURL(origin + "/apps/" + registered.id);
    const frame = page.frameLocator("iframe");
    await frame.getByText("Scripts work").waitFor();
    await frame.getByText("WebSocket echo").waitFor();
    await frame.getByText("Streaming first last").waitFor();
    await frame.getByText("Control API blocked").waitFor();
    assert(
      sameHostCookieSeen,
      "Disposable HttpOnly Jelly cookie was not observed at the same-host app port",
    );
    assert(
      (await page.locator("iframe").getAttribute("src")) === registered.url,
      "Viewer rewrote the canonical URL",
    );
    await frame
      .getByRole("button", { name: "Try top navigation and popup" })
      .click();
    await frame
      .getByText('{"topDenied":true,"popupDenied":true}', { exact: true })
      .waitFor();
    assert(
      popups === 0 && page.url() === origin + "/apps/" + registered.id,
      "Frame replaced Jelly or opened a popup",
    );
    await frame.getByRole("button", { name: "Submit form" }).click();
    await frame.getByText("Form submitted: works").waitFor();
    await page.reload();
    await page.frameLocator("iframe").getByText("Scripts work").waitFor();
    await page
      .frameLocator("iframe")
      .getByRole("link", { name: "Internal report" })
      .click();
    await page.frameLocator("iframe").getByText("Scripts work").waitFor();
    assert(
      page.url() === origin + "/apps/" + registered.id,
      "Internal frame navigation changed viewer URL",
    );
    await page.getByRole("button", { name: "Back to Apps" }).click();
    await page.waitForURL(origin + "/apps");
    await page.waitForFunction(
      (id) => document.activeElement?.id === `jelly-app-${id}-launch`,
      registered.id,
    );
    // Reload recreates Home; re-enter without reload to prove retained scroll.
    await scroller.evaluate((element) => {
      element.scrollTop = 220;
    });
    const currentScroll = await scroller.evaluate(
      (element) => element.scrollTop,
    );
    assert(currentScroll > 0, "Home scroll fixture must be genuinely scrolled");
    await launch.click({ force: true });
    await page.getByRole("button", { name: "Back to Apps" }).click();
    await page.waitForFunction(
      (id) => document.activeElement?.id === `jelly-app-${id}-launch`,
      registered.id,
    );
    assert(
      (await scroller.evaluate((element) => element.scrollTop)) ===
        currentScroll,
      "Back did not restore Home scroll",
    );
    assert(
      (await page.getByText("Open in new tab", { exact: true }).count()) === 0,
      "Alternate launch mode remains",
    );
    // Add requires just name/URL and gives the concise trust notice.
    await page.getByRole("button", { name: "Add app", exact: true }).click();
    await page.getByText(/Only add apps you trust/).waitFor();
    await page
      .getByLabel("Name", { exact: true })
      .fill(`Browser added ${width}`);
    await page
      .getByLabel("App URL", { exact: true })
      .fill(appServer.url.origin + "/dashboard");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add app", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const added = jelly.service.apps.list({ q: `Browser added ${width}` })
      .history[0]!;
    assert(added && !added.starredAt, "Registration auto-starred the app");
    for (const app of blocked) {
      await page.goto(origin + "/apps/" + app.id);
      await page.getByRole("button", { name: "Back to Apps" }).waitFor();
      await page.waitForTimeout(200);
      if (app.name.startsWith("denied"))
        assert(
          !page.frames().some((frame) => frame.url() === app.url),
          "Target framing headers were bypassed",
        );
      else
        await page
          .frameLocator("iframe")
          .getByRole("heading", {
            name: "Framed sign-in needs app configuration",
          })
          .waitFor();
      await page
        .getByRole("button", { name: `Options for ${app.name}` })
        .click();
      await page
        .getByRole("menuitem", { name: "Embedding help / retry" })
        .click();
      await page
        .getByText("App not appearing? Embedding help", { exact: true })
        .click();
      await page.getByText(/third-party-cookie restrictions/).waitFor();
      await page.getByRole("button", { name: "Retry frame" }).click();
      assert(
        (await page.getByText("Open in new tab", { exact: true }).count()) ===
          0,
        "Framing failure supplied alternate launch",
      );
    }
    // Jelly itself cannot be framed even by trusted app origins.
    await page.goto(appServer.url.origin);
    await page.evaluate((target) => {
      const frame = document.createElement("iframe");
      frame.src = target;
      document.body.append(frame);
    }, origin + "/apps");
    await page.waitForTimeout(300);
    assert(
      !page.frames().some((frame) => frame.url() === origin + "/apps"),
      "Jelly became frameable",
    );
    await context.close();
    console.log(
      `PASS trusted viewer/forms/scripts/streaming/ws/navigation/framing/trust UI at ${width}px`,
    );
  }
  const key = join(dir, "fixture.key"),
    cert = join(dir, "fixture.crt");
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
      "/CN=127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  assert(generated.exitCode === 0, "TLS fixture certificate failed");
  let tlsBackendOrigin = origin;
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      const url = new URL(request.url);
      const response = await fetch(
        tlsBackendOrigin + url.pathname + url.search,
        {
          method: request.method,
          headers: request.headers,
          ...(request.method !== "GET" && request.method !== "HEAD"
            ? { body: request.body }
            : {}),
        },
      );
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  // Exact temporary TLS alias used by this disposable reverse proxy only.
  // startApp's allowlist was intentionally immutable, so use a second fixture instance.
  const secureJelly = await startApp({
    dataDir: join(dir, "secure"),
    configDir: join(dir, "secure-config"),
    port: 0,
    allowedOrigins: [proxy.url.origin],
  });
  tlsBackendOrigin = secureJelly.server.url.origin;
  try {
    const mixedApp = secureJelly.service.apps.register({
      name: "Mixed HTTP",
      url: appServer.url.href,
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(proxy.url.origin + "/apps/" + mixedApp.id);
    await page.getByText(/HTTPS Jelly cannot embed this HTTP app/).waitFor();
    assert(
      (await page.locator("iframe").count()) === 0,
      "HTTPS viewer attempted an HTTP frame",
    );
    await page.getByRole("button", { name: "Back to Apps" }).click();
    await context.close();
    console.log("PASS real HTTPS mixed-content configuration guidance");
  } finally {
    await secureJelly.close();
  }
  const deadServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("temporary"),
  });
  const dead = jelly.service.apps.register({
    name: "Downtime",
    url: deadServer.url.href,
  });
  deadServer.stop(true);
  const page = await browser.newPage();
  await page.goto(origin + "/apps/" + dead.id);
  await page.getByRole("button", { name: "Options for Downtime" }).click();
  await page.getByRole("menuitem", { name: "Embedding help / retry" }).click();
  await page
    .getByText("App not appearing? Embedding help", { exact: true })
    .click();
  await page.getByText(/cross-origin failure/).waitFor();
  await page.getByRole("button", { name: "Back to Apps" }).click();
  console.log(
    "PASS downtime recovery; no live registry, credentials, services or remote-device claims",
  );
} finally {
  proxy?.stop(true);
  await browser.close();
  appServer.stop(true);
  await jelly.close();
  rmSync(dir, { recursive: true, force: true });
}
