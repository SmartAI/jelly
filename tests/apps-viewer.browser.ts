import { chromium, type Page, type BrowserContext } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRecord, AppsCapabilities } from "../src/shared/apps";
import { startApp } from "./fixtures/app";

// Disposable DB and fake Apps HTTP adapters only. No real units, tailnet, models,
// browser credentials, Jelly restart, or live database are used by this suite.
const dir = mkdtempSync(join(tmpdir(), "jelly-apps-viewer-"));
let backendOrigin = "";
// A real loopback HTTP fixture supplies the backend-owned SPA route seam. Using
// Playwright fulfill for navigation falsely classifies loopback as public in
// Chromium's Local Network Access checks; no security flags are disabled.
const frontendServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || /^\/(?:apps|agents)(?:\/|$)/.test(url.pathname))
      return new Response(Bun.file("dist/index.html"), {
        headers: { "Content-Type": "text/html" },
      });
    const response = await fetch(
      `${backendOrigin}${url.pathname}${url.search}`,
      {
        method: request.method,
        headers: request.headers,
        ...(request.method !== "GET" && request.method !== "HEAD"
          ? { body: request.body }
          : {}),
        signal: request.signal,
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
});
const jellyOrigin = `http://127.0.0.1:${frontendServer.port}`;
const jelly = await startApp({
  dataDir: dir,
  configDir: join(dir, "config"),
  port: 0,
  allowedOrigins: [jellyOrigin],
});
backendOrigin = jelly.server.url.origin;
const agentId = jelly.store.agents()[0]!.id;
const fixtureProjectDirectory = join(dir, "project");
mkdirSync(fixtureProjectDirectory);
const fixtureProject = jelly.service.saveProject(null, {
  name: "Fixture project",
  defaultCwd: fixtureProjectDirectory,
});
const appServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/socket" && server.upgrade(request))
      return;
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:90px 16px;font:16px system-ui"><h1>Disposable app</h1><p id="socket">Connecting WebSocket</p><a id="direct-home" href="${jellyOrigin}/apps">Jelly home</a><button id="route">Internal report</button><button id="many">Many internal navigations</button><button id="escape">Try top navigation and popup</button><p id="isolation"></p><script>
      const jellyOrigin = ${JSON.stringify(jellyOrigin)};
      const appId = 'embedded';
      let loads = Number(sessionStorage.getItem('loads') || 0) + 1; sessionStorage.setItem('loads', String(loads));
      if (parent !== window) parent.postMessage({type:'jelly:ready', appId}, jellyOrigin);
      addEventListener('message', event => {
        if (event.source === parent && event.origin === jellyOrigin && event.data?.type === 'jelly:viewer' && event.data.appId === appId && Object.keys(event.data).sort().join(',') === 'appId,type') document.getElementById('direct-home').hidden = true;
      });
      document.getElementById('route').onclick = () => { history.replaceState(null,'','/reports/1'); parent.postMessage({type:'jelly:route',appId,route:'/reports/1'},jellyOrigin); };
      document.getElementById('many').onclick = () => { for (let i=0;i<4;i++) history.pushState(null,'','/internal/'+i); parent.postMessage({type:'jelly:route',appId,route:'/internal/3'},jellyOrigin); };
      document.getElementById('escape').onclick = async () => {
        let isolated = false, topDenied = false, popupDenied = false, fullscreenDenied = false;
        try { parent.document.body; } catch { isolated = true; }
        try { top.location.href = jellyOrigin+'/escaped'; } catch { topDenied = true; }
        try { popupDenied = window.open(jellyOrigin+'/escaped') === null; } catch { popupDenied = true; }
        try { await document.documentElement.requestFullscreen(); } catch { fullscreenDenied = true; }
        document.getElementById('isolation').textContent = JSON.stringify({isolated,topDenied,popupDenied,fullscreenDenied});
      };
      const socket = new WebSocket(location.origin.replace('http','ws')+'/socket'); socket.onmessage = () => document.getElementById('socket').textContent = 'WebSocket connected';
    </script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
  websocket: {
    open(socket) {
      socket.send("connected");
    },
    message() {},
  },
});
const deniedServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response("This app forbids framing", {
      headers: {
        "Content-Type": "text/html",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      },
    });
  },
});
const appOrigin = `http://127.0.0.1:${appServer.port}`;
const deniedOrigin = `http://127.0.0.1:${deniedServer.port}`;
const capabilities: AppsCapabilities & { embedding?: boolean } = {
  supported: true,
  platform: "linux",
  managedDeployment: true,
  systemd: true,
  lingering: true,
  tailscale: true,
  tailnetAddresses: ["100.64.0.1"],
  tailnetHostname: "fixture.tailnet.test",
  gatewayNode: true,
  gatewayNodeVersion: "v22.18.0",
  embedding: true,
  privateHttps: false,
  cookieIsolation: "http-only-prefixed",
  warnings: [],
};
function record(id: string, values: Partial<AppRecord> = {}): AppRecord {
  return {
    id,
    slug: id,
    name: id,
    description: "Disposable fixture",
    iconAssetId: null,
    projectId: null,
    builderAgentId: agentId,
    sourceDirectory: null,
    managementMode: "managed",
    launchMode: "embedded",
    runtimeSocket: null,
    gatewayPort: appServer.port ?? null,
    unitName: `jelly-app-${id}.service`,
    deploymentRevision: "fixture",
    executable: null,
    args: [],
    healthPath: "/health",
    localOrigin: appOrigin,
    tailnetOrigin: null,
    allowedJellyOrigins: [jellyOrigin],
    desiredState: "ready",
    starredAt: null,
    lastOpenedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    viewerCorner: "top-left",
    observation: {
      serviceState: "running",
      httpHealthy: true,
      checkedAt: null,
      tailnetReachable: null,
      lastError: null,
    },
    ...values,
  };
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function poll(
  test: () => Promise<boolean> | boolean,
  message: string,
  timeout = 4000,
) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await test()) return;
    await Bun.sleep(20);
  }
  throw new Error(message);
}
async function fixtureApps(context: BrowserContext) {
  const starredAt = "2026-02-01T00:00:00.000Z";
  const records = [
    record("embedded", { starredAt }),
    record("favorite-two", { starredAt }),
    record("favorite-three", { starredAt }),
    record("linked", {
      managementMode: "linked",
      launchMode: "direct",
      unitName: null,
      createdAt: "2026-03-02T00:00:00.000Z",
    }),
    record("blocked", {
      localOrigin: deniedOrigin,
      createdAt: "2026-03-01T00:00:00.000Z",
    }),
    record("stopped", {
      desiredState: "stopped",
      createdAt: "2026-03-03T00:00:00.000Z",
      observation: {
        serviceState: "stopped",
        httpHealthy: false,
        checkedAt: null,
        tailnetReachable: null,
        lastError: "Stopped explicitly",
      },
    }),
    ...Array.from({ length: 42 }, (_, index) =>
      record(`history-${String(index).padStart(2, "0")}`),
    ),
  ];
  const visits = new Map<string, Set<string>>();
  const launches: { appId: string; navigationId: string }[] = [];
  let failStar = true;
  await context.route("**/api/apps**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const path = url.pathname;
    const data = request.method() === "POST" ? request.postDataJSON() : {};
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/apps/capabilities") return json(capabilities);
    if (path === "/api/apps") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const matching = records.filter((app) =>
        `${app.name} ${app.description}`.toLowerCase().includes(q),
      );
      const starred = matching
        .filter((app) => app.starredAt)
        .sort(
          (a, b) =>
            b.starredAt!.localeCompare(a.starredAt!) ||
            a.id.localeCompare(b.id),
        );
      const history = matching
        .filter((app) => !app.starredAt)
        .sort(
          (a, b) =>
            (b.lastOpenedAt ?? b.createdAt).localeCompare(
              a.lastOpenedAt ?? a.createdAt,
            ) || a.id.localeCompare(b.id),
        );
      const offset = Number(url.searchParams.get("after") ?? 0),
        limit = 30;
      return json({
        starred,
        history: history.slice(offset, offset + limit),
        after: offset + limit < history.length ? String(offset + limit) : null,
        capabilities,
      });
    }
    const match = /^\/api\/apps\/([^/]+)(?:\/(.+))?$/.exec(path);
    const app = records.find(
      (app) => app.id === decodeURIComponent(match?.[1] ?? ""),
    );
    if (!app) return json({ error: "App not found." }, 404);
    if (request.method() === "POST")
      assert(
        !!request.headers()["x-jelly-csrf"],
        "Apps write omitted control-session CSRF",
      );
    if (match?.[2] === "launch") {
      launches.push({ appId: app.id, navigationId: data.navigationId });
      const seen = visits.get(app.id) ?? new Set<string>();
      if (!seen.has(data.navigationId)) {
        seen.add(data.navigationId);
        app.lastOpenedAt = new Date().toISOString();
        visits.set(app.id, seen);
      }
    } else if (match?.[2] === "star") {
      if (failStar && app.id === "linked") {
        failStar = false;
        await Bun.sleep(100);
        return json({ error: "Fixture star save failed" }, 503);
      }
      app.starredAt = data.starred
        ? (app.starredAt ?? new Date().toISOString())
        : null;
    } else if (match?.[2] === "control") {
      app.desiredState = data.action === "stop" ? "stopped" : "ready";
      app.observation.serviceState =
        data.action === "stop" ? "stopped" : "running";
      app.observation.httpHealthy = data.action !== "stop";
    } else if (match?.[2] === "logs")
      return json({
        lines: ["fixture log [redacted]"],
        truncated: false,
        warning: "Best effort only",
      });
    return json(app);
  });
  return { records, visits, launches };
}
async function settledScreenshot(page: Page, path: string) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const finite = document
      .getAnimations()
      .filter(
        (animation) => animation.effect?.getTiming().iterations !== Infinity,
      );
    await Promise.all(
      finite.map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path });
}
async function home(page: Page) {
  await page.getByRole("button", { name: "Jelly home", exact: true }).click();
  await page.waitForURL(`${jellyOrigin}/apps`);
  await page.getByRole("heading", { name: "Apps", exact: true }).waitFor();
}
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
});
try {
  const screenshots = ".pi/subagents/artifacts/outputs/apps-findings-fixed-ui";
  mkdirSync(screenshots, { recursive: true });
  for (const width of [320, 390, 1280, 1440]) {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        colorScheme,
        reducedMotion: "reduce",
      });
      try {
        await fixtureApps(context);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setSafeAreaInsetsOverride", {
          insets: { top: 32, left: 9, bottom: 28, right: 13 },
        });
        await page.goto(`${jellyOrigin}/apps`);
        await page
          .getByRole("button", { name: "Open embedded", exact: true })
          .waitFor();
        const checkNavigation = async () => {
          const geometry = await page
            .locator(".destination-navigation")
            .evaluate((element) => {
              const nav = element.getBoundingClientRect();
              const links = [...element.querySelectorAll("a")].map((link) =>
                link.getBoundingClientRect(),
              );
              return {
                height: nav.height,
                width: nav.width,
                left: nav.left,
                desktopSidebar: !!element.closest(".destination-sidebar"),
                sidebarWidth:
                  document
                    .querySelector(".destination-sidebar")
                    ?.getBoundingClientRect().width ?? 0,
                appsLeft: document
                  .querySelector(".apps-layer")!
                  .getBoundingClientRect().left,
                links: links.map((link) => ({
                  width: link.width,
                  height: link.height,
                  topGap: link.top - nav.top - (innerWidth < 768 ? 0 : 32),
                  bottomGap:
                    nav.bottom - link.bottom - (innerWidth < 768 ? 28 : 0),
                  inside: link.left >= nav.left && link.right <= nav.right,
                })),
                bodyTop: document
                  .querySelector(".destination-body")!
                  .getBoundingClientRect().top,
                bodyBottom: document
                  .querySelector(".destination-body")!
                  .getBoundingClientRect().bottom,
                navTop: nav.top,
                navBottom: nav.bottom,
                viewportHeight: innerHeight,
                shadow: getComputedStyle(element).boxShadow,
                followsContent:
                  element.previousElementSibling?.classList.contains(
                    "destination-body",
                  ),
              };
            });
          assert(
            Math.abs(geometry.height - (width < 768 ? 92 : 96)) < 1,
            "Destination navigation does not reserve the appropriate safe area",
          );
          assert(
            geometry.links.every(
              (link) =>
                link.width >= 44 &&
                link.height >= 44 &&
                link.inside &&
                link.topGap >= 8 &&
                link.bottomGap >= 8 &&
                Math.abs(link.topGap - link.bottomGap) <= 2,
            ),
            "Destination links have cramped/unbalanced padding or overflow",
          );
          assert(
            width < 768
              ? Math.abs(geometry.bodyTop) < 1 &&
                  Math.abs(geometry.bodyBottom - geometry.navTop) < 1 &&
                  Math.abs(geometry.navBottom - geometry.viewportHeight) < 1 &&
                  geometry.followsContent &&
                  geometry.shadow.includes("inset") &&
                  !geometry.desktopSidebar
              : Math.abs(geometry.navTop) < 1 &&
                  Math.abs(geometry.left) < 1 &&
                  geometry.desktopSidebar &&
                  Math.abs(
                    geometry.sidebarWidth - (width >= 1440 ? 304 : 280),
                  ) < 1 &&
                  Math.abs(geometry.width - geometry.sidebarWidth) <= 1 &&
                  Math.abs(geometry.bodyBottom - geometry.viewportHeight) < 1 &&
                  geometry.appsLeft >= geometry.sidebarWidth,
            "Switcher is not in the desktop sidebar/mobile footer or content overlaps it",
          );
        };
        await checkNavigation();
        const checkDestinationHeading = async (selector: string) => {
          const heading = await page.locator(selector).evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              width: bounds.width,
              height: bounds.height,
              top: bounds.top,
              clipPath: getComputedStyle(element).clipPath,
            };
          });
          assert(
            heading.width > 20 &&
              heading.height > 16 &&
              heading.top >= 32 &&
              heading.clipPath === "none",
            "Restored destination heading is not visible",
          );
        };
        await checkDestinationHeading("#apps-home-title");
        if (width < 768)
          assert(
            await page.locator(".apps-home-header").evaluate((element) => {
              const header = element.getBoundingClientRect();
              const build = element
                .querySelector(".apps-build")!
                .getBoundingClientRect();
              return Math.abs(header.right - build.right) < 1;
            }),
            "Mobile Build action shifted left when the repeated heading was hidden",
          );
        assert(
          await page
            .getByRole("searchbox")
            .evaluate(
              (element) =>
                parseFloat(getComputedStyle(element).borderRadius) >= 12,
            ),
          "Apps search lost its Jelly rounded treatment",
        );
        assert(
          await page
            .locator(".apps-home-header")
            .evaluate(
              (element) =>
                getComputedStyle(element).padding === "0px" &&
                element.getBoundingClientRect().height >= 44 &&
                element.getBoundingClientRect().height < 80,
            ),
          "Apps header inherits unrelated chat padding/height",
        );
        await page
          .locator(".destination-navigation")
          .getByRole("link", { name: "Agents", exact: true })
          .click();
        await page
          .locator(".agents-layer[data-active='true']")
          .waitFor({ state: "visible" });
        await checkNavigation();
        await checkDestinationHeading(".inbox-toolbar[data-scope='root'] h1");
        if (width < 768)
          assert(
            await page
              .locator(".inbox-toolbar[data-scope='root']")
              .evaluate((element) => {
                const toolbar = element.getBoundingClientRect();
                const menu = element
                  .querySelector("button")!
                  .getBoundingClientRect();
                return (
                  Math.abs(toolbar.right - menu.right) < 1 && menu.height >= 44
                );
              }),
            "Root Agents menu moved away from the right edge or lost its hit target",
          );
        await settledScreenshot(
          page,
          `${screenshots}/${width}-${colorScheme}-agents-root.png`,
        );
        await page
          .getByRole("button", { name: new RegExp(fixtureProject.name) })
          .click();
        const projectHeading = page.getByRole("heading", {
          name: fixtureProject.name,
          exact: true,
        });
        await projectHeading.waitFor();
        assert(
          await projectHeading.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.width > 20 &&
              bounds.height > 16 &&
              getComputedStyle(element).clipPath === "none"
            );
          }),
          "Contextual project title was hidden along with the duplicate destination heading",
        );
        await settledScreenshot(
          page,
          `${screenshots}/${width}-${colorScheme}-agents-project.png`,
        );
        await page
          .getByRole("button", { name: "Back to all agents", exact: true })
          .click();
        await checkDestinationHeading(".inbox-toolbar[data-scope='root'] h1");
        if (width < 768)
          assert(
            await page
              .locator(".agents-layer .sidebar")
              .evaluate(
                (element) =>
                  getComputedStyle(element).paddingTop === "32px" &&
                  getComputedStyle(element).paddingBottom === "16px",
              ),
            "Agents does not reserve the top safe area or reserves the footer safe area twice",
          );
        assert(
          await page
            .locator(".agents-layer .agent-create-fab")
            .evaluate((element) => {
              const create = element.getBoundingClientRect();
              const footer = document
                .querySelector(".destination-navigation")!
                .getBoundingClientRect();
              return innerWidth < 768
                ? create.bottom <= footer.top - 12
                : create.top >= footer.bottom + 12;
            }),
          "Agent creation overlaps bottom navigation",
        );
        await page
          .locator(".agents-layer .agent-row")
          .filter({ hasText: "Jelly" })
          .click();
        await page.locator(".agents-layer .composer textarea").waitFor();
        const composerFits = () =>
          page.locator(".agents-layer .composer-wrap").evaluate((element) => {
            const composer = element.getBoundingClientRect();
            const footer = document
              .querySelector(".destination-navigation")!
              .getBoundingClientRect();
            return (
              composer.top >= 0 &&
              (innerWidth < 768
                ? composer.bottom <= innerHeight + 1
                : composer.left >= footer.right &&
                  composer.bottom <= innerHeight + 1)
            );
          });
        assert(
          await composerFits(),
          "Chat composer overlaps the bottom switcher",
        );
        if (width < 768) {
          assert(
            await page.locator(".destination-navigation").isHidden(),
            "Mobile chat still shows the destination switcher",
          );
          assert(
            await page
              .locator(".agents-layer")
              .evaluate(
                (element) =>
                  Math.abs(
                    element.getBoundingClientRect().height - innerHeight,
                  ) < 1,
              ),
            "Mobile chat retains an empty footer reservation",
          );
          await page
            .locator(".agents-layer .composer textarea")
            .fill("Preserve draft when hiding mobile chat tabs.");
          await settledScreenshot(
            page,
            `${screenshots}/${width}-${colorScheme}-chat.png`,
          );
          await page.locator(".agents-layer .composer textarea").focus();
          await page.evaluate(() => {
            const viewport = window.visualViewport!;
            Object.defineProperty(viewport, "height", {
              configurable: true,
              value: 420,
            });
            viewport.dispatchEvent(new Event("resize"));
          });
          await poll(
            async () =>
              page
                .locator(".agents-layer > .app")
                .getAttribute("data-keyboard-open")
                .then((value) => value === "true"),
            "Keyboard viewport was not detected",
          );
          assert(
            await page
              .locator(".agents-layer .composer-wrap")
              .evaluate(
                (element) => element.getBoundingClientRect().bottom <= 421,
              ),
            "Bottom navigation displaces the composer under the keyboard",
          );
          await page.evaluate(() => {
            delete (window.visualViewport as unknown as { height?: number })
              .height;
            window.visualViewport!.dispatchEvent(new Event("resize"));
            (document.activeElement as HTMLElement)?.blur();
          });
          await poll(
            async () =>
              page
                .locator(".agents-layer > .app")
                .getAttribute("data-keyboard-open")
                .then((value) => value !== "true"),
            "Keyboard viewport did not reset",
          );
          assert(
            await composerFits(),
            "Composer overlaps bottom navigation after keyboard dismissal",
          );
          await page
            .locator(".agents-layer .conversation-header .mobile-back")
            .click();
          await poll(
            () => page.locator(".destination-navigation").isVisible(),
            "Returning to the inbox did not restore mobile tabs",
          );
          await checkNavigation();
          await page.goForward();
          await page.locator(".agents-layer .composer textarea").waitFor();
          assert(
            await page.locator(".destination-navigation").isHidden(),
            "Browser Forward restored mobile tabs in chat",
          );
          assert(
            (await page.locator(".composer textarea").inputValue()) ===
              "Preserve draft when hiding mobile chat tabs.",
            "Chat navigation visibility lost the saved draft",
          );
          await page.goBack();
          await poll(
            () => page.locator(".destination-navigation").isVisible(),
            "Browser Back did not restore inbox navigation",
          );
        }
        await page
          .locator(".destination-navigation")
          .getByRole("link", { name: "Apps", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Open embedded", exact: true })
          .waitFor();
        await settledScreenshot(
          page,
          `${screenshots}/${width}-${colorScheme}-home.png`,
        );

        await page
          .getByRole("button", { name: "Options for embedded", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Details", exact: true })
          .click();
        const detailDialog = page.getByRole("dialog", {
          name: "embedded",
          exact: true,
        });
        await detailDialog.waitFor();
        await detailDialog
          .getByText("Service and diagnostics", { exact: true })
          .click();
        const labelsFit = await detailDialog
          .locator("dt")
          .evaluateAll((elements) =>
            elements.every((element) => {
              const style = getComputedStyle(element);
              const label = element.getBoundingClientRect();
              const value = element.nextElementSibling!.getBoundingClientRect();
              return (
                style.overflowWrap === "normal" &&
                style.wordBreak === "normal" &&
                element.scrollWidth <= element.clientWidth + 1 &&
                (innerWidth > 480 ||
                  (value.top >= label.bottom - 1 &&
                    Math.abs(value.left - label.left) < 1))
              );
            }),
          );
        assert(
          labelsFit,
          "Diagnostic labels split mid-word, overflow, or fail to stack on phones",
        );
        await settledScreenshot(
          page,
          `${screenshots}/${width}-${colorScheme}-details.png`,
        );
        await detailDialog
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await detailDialog.waitFor({ state: "hidden" });

        await page
          .getByRole("button", { name: "Options for embedded", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Remove from Apps", exact: true })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await poll(
          async () =>
            dialog.evaluate((element) => {
              const label = element
                .querySelector(".apps-uninstall")!
                .getBoundingClientRect();
              const checkbox = element
                .querySelector(".apps-uninstall input")!
                .getBoundingClientRect();
              const actions = element
                .querySelector(".apps-detail-actions")!
                .getBoundingClientRect();
              return (
                label.height < 160 &&
                Math.abs(checkbox.width - 24) < 0.1 &&
                actions.bottom <= innerHeight &&
                parseFloat(getComputedStyle(element).opacity) >= 0.99
              );
            }),
          "Uninstall label/actions are vertically stretched, clipped or still off-screen",
        );
        const layout = await dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const label = element
            .querySelector(".apps-uninstall")!
            .getBoundingClientRect();
          const checkbox = element.querySelector<HTMLInputElement>(
            ".apps-uninstall input",
          )!;
          const input = checkbox.getBoundingClientRect();
          const text = element
            .querySelector(".apps-uninstall span")!
            .getBoundingClientRect();
          const actions = element
            .querySelector(".apps-detail-actions")!
            .getBoundingClientRect();
          return {
            checked: checkbox.checked,
            inputWidth: input.width,
            inputHeight: input.height,
            textWidth: text.width,
            textInside:
              text.left >= label.left + input.width &&
              text.right <= bounds.right &&
              text.bottom <= label.bottom,
            actionsVisible:
              actions.top >= bounds.top &&
              actions.bottom <= bounds.bottom &&
              actions.bottom <= innerHeight,
            // Native sheet borders/transforms can add two rounding pixels in
            // Chromium; actual descendant bounds must still remain inside.
            overflow: element.scrollWidth > element.clientWidth + 2,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            outside: [...element.querySelectorAll<HTMLElement>("*")]
              .filter(
                (child) =>
                  child.getBoundingClientRect().right > bounds.right + 1,
              )
              .map((child) => ({
                className: child.className,
                width: child.getBoundingClientRect().width,
                right: child.getBoundingClientRect().right,
                limit: bounds.right,
              })),
          };
        });
        assert(
          !layout.checked &&
            Math.abs(layout.inputWidth - 24) < 1 &&
            Math.abs(layout.inputHeight - 24) < 1,
          "Uninstall checkbox inherited text-input dimensions",
        );
        assert(
          layout.textWidth > 100 &&
            layout.textInside &&
            !layout.overflow &&
            layout.outside.length === 0 &&
            layout.actionsVisible,
          `Uninstall explanation/actions are clipped, off-screen or overflowing: ${JSON.stringify(layout)}`,
        );
        const checkbox = dialog.getByRole("checkbox", {
          name: /Uninstall Jelly-owned service/,
        });
        await checkbox.focus();
        await checkbox.press("Space");
        await dialog
          .getByRole("button", {
            name: "Uninstall service and remove",
            exact: true,
          })
          .waitFor();
        await settledScreenshot(
          page,
          `${screenshots}/${width}-${colorScheme}-remove.png`,
        );
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        console.log(
          `PASS destination navigation padding, safe areas and visible uninstall choice: ${width}px ${colorScheme}`,
        );
      } finally {
        await context.close();
      }
    }
  }
  // Moving the same switcher across breakpoints must not remount chat state.
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 844 },
    });
    try {
      await fixtureApps(context);
      const page = await context.newPage();
      await page.goto(`${jellyOrigin}/apps`);
      await page
        .getByRole("button", { name: "Open embedded", exact: true })
        .waitFor();
      await page.getByRole("link", { name: "Agents", exact: true }).click();
      await page
        .locator(".agents-layer .agent-row")
        .filter({ hasText: "Jelly" })
        .click();
      const draft =
        "Preserve this draft while moving navigation across breakpoints.";
      await page.locator(".composer textarea").fill(draft);
      await page.getByRole("link", { name: "Apps", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await poll(
        () =>
          page
            .locator(".destination-sidebar")
            .count()
            .then((count) => count === 0),
        "Desktop sidebar navigation remains at mobile width",
      );
      assert(
        await page
          .locator(".destination-navigation")
          .evaluate(
            (element) =>
              Math.abs(element.getBoundingClientRect().bottom - innerHeight) <
              1,
          ),
        "Responsive switcher did not move to the mobile footer",
      );
      await page.getByRole("link", { name: "Agents", exact: true }).click();
      await page.locator(".composer textarea").waitFor();
      assert(
        (await page.locator(".composer textarea").inputValue()) === draft,
        "Responsive navigation discarded the chat draft",
      );
      await page.setViewportSize({ width: 1440, height: 844 });
      await page.locator(".destination-sidebar").waitFor();
      assert(
        (await page
          .locator(".destination-sidebar .destination-navigation")
          .count()) === 1,
        "Switcher did not return to the desktop sidebar",
      );
      assert(
        (await page.locator(".composer textarea").inputValue()) === draft,
        "Returning to desktop remounted the workspace",
      );
      console.log(
        "PASS desktop/sidebar and mobile/footer resize preserves workspace draft",
      );
    } finally {
      await context.close();
    }
  }
  for (const [device, width, height] of [
    ["desktop", 1280, 900],
    ["phone", 390, 844],
    ["narrow-phone", 320, 740],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    const fake = await fixtureApps(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${jellyOrigin}/apps`);
    await page
      .getByRole("button", { name: "Open embedded", exact: true })
      .waitFor();
    const columns = await page
      .locator(".apps-starred-grid")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      );
    assert(
      width > 600 || columns === 3,
      `${device}: favorites do not have three phone columns`,
    );
    assert(
      await page
        .locator(".apps-home")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      `${device}: Apps overflows horizontally`,
    );
    const targetsFit = await page
      .locator(".app-row-actions > button")
      .evaluateAll((elements) =>
        elements.every((element) => {
          const box = element.getBoundingClientRect();
          return box.width >= 44 && box.height >= 44;
        }),
      );
    assert(targetsFit, `${device}: star/menu actions shrink below 44px`);

    const star = page.getByRole("button", { name: "Star linked", exact: true });
    await star.focus();
    await star.press("Enter");
    await page.getByRole("button", { name: "Retry star for linked" }).waitFor();
    assert(
      await star.evaluate((element) => document.activeElement === element),
      `${device}: rollback lost keyboard star focus`,
    );
    assert(fake.launches.length === 0, "Starring recorded a launch");
    await page.getByRole("button", { name: "Retry star for linked" }).click();
    await page
      .getByRole("button", { name: "Unstar linked", exact: true })
      .waitFor();
    const unstar = page.getByRole("button", {
      name: "Unstar linked",
      exact: true,
    });
    await poll(
      async () => (await unstar.getAttribute("aria-busy")) === "false",
      "Star retry did not settle",
    );
    await unstar.focus();
    await unstar.press("Space");
    await star.waitFor();
    assert(
      await star.evaluate((element) => document.activeElement === element),
      `${device}: moving between sections lost focus`,
    );
    await page
      .getByRole("button", { name: "Options for linked", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("menuitem", { name: "Details", exact: true })
      .waitFor();
    await page.keyboard.press("End");
    assert(
      await page
        .getByRole("menuitem", { name: "Remove from Apps", exact: true })
        .evaluate((element) => document.activeElement === element),
      "Menu End key did not focus last action",
    );
    await page.keyboard.press("Escape");
    assert(
      await page
        .getByRole("button", { name: "Options for linked", exact: true })
        .evaluate((element) => document.activeElement === element),
      "Menu Escape did not restore trigger focus",
    );

    await page.getByRole("button", { name: "Load more apps" }).click();
    await page
      .getByRole("button", { name: "Open history-41", exact: true })
      .waitFor();
    await page.getByRole("searchbox").fill("favorite");
    await page
      .getByRole("button", { name: "Open linked", exact: true })
      .waitFor({ state: "hidden" });
    assert(
      (await page
        .getByRole("heading", { name: "History", exact: true })
        .count()) === 0,
      "Only favorites should omit empty History",
    );
    await page.getByRole("searchbox").fill("");
    await page
      .getByRole("button", { name: "Open linked", exact: true })
      .waitFor();

    // The viewer never covers its home controls with app HTML, even at a notch.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 32, left: 9, bottom: 28, right: 13 },
    });
    const scroll = await page.locator(".apps-home").evaluate((element) => {
      element.scrollTop = 180;
      return element.scrollTop;
    });
    await page
      .getByRole("button", { name: "Open embedded", exact: true })
      .click();
    await page.waitForURL(`${jellyOrigin}/apps/embedded`);
    assert(
      (await page.locator(".destination-navigation").count()) === 0,
      "Fullscreen viewer retains bottom navigation",
    );
    assert(
      await page
        .locator(".app-viewer")
        .evaluate(
          (element) =>
            Math.abs(element.getBoundingClientRect().height - innerHeight) < 1,
        ),
      "App viewer loses fullscreen height to hidden navigation",
    );
    const frame = page.frameLocator(".app-viewer iframe");
    await frame.getByText("WebSocket connected", { exact: true }).waitFor();
    await poll(
      () => (fake.visits.get("embedded")?.size ?? 0) === 1,
      "Viewer entry did not record one visit",
    );
    assert(
      fake.launches.filter((launch) => launch.appId === "embedded").length ===
        1,
      "Tile + viewer duplicated the same launch request",
    );
    const sandbox = await page.locator("iframe").getAttribute("sandbox");
    assert(
      sandbox === "allow-scripts allow-forms allow-same-origin",
      "Viewer granted unexpected sandbox capability",
    );
    assert(
      (await page.locator("iframe").getAttribute("allow"))?.includes(
        "fullscreen 'none'",
      ),
      "Viewer permits fullscreen",
    );
    const homeBox = await page
      .getByRole("button", { name: "Jelly home", exact: true })
      .boundingBox();
    assert(
      homeBox && homeBox.y >= 32 && homeBox.x >= 9 && homeBox.height >= 44,
      `${device}: home pill ignores safe areas/minimum size`,
    );
    assert(
      await frame.locator("#direct-home").isHidden(),
      "Validated handshake did not hide duplicate direct home link",
    );
    await frame.getByRole("button", { name: "Internal report" }).click();
    await page.waitForURL(`${jellyOrigin}/apps/embedded/reports/1`);
    assert(
      (await frame
        .locator("body")
        .evaluate(() => sessionStorage.getItem("loads"))) === "1",
      "Bridge route reporting reloaded the iframe",
    );
    assert(
      fake.visits.get("embedded")?.size === 1,
      "Internal route reporting counted as a new visit",
    );
    const validUrl = page.url();
    await page.evaluate(() => {
      window.postMessage(
        {
          type: "jelly:route",
          appId: "embedded",
          route: "/stolen?token=secret",
        },
        window.location.origin,
      );
      window.postMessage(
        { type: "jelly:route", appId: "embedded", route: "/wrong-source" },
        window.location.origin,
      );
    });
    await Bun.sleep(50);
    assert(
      page.url() === validUrl,
      "Viewer accepted a bridge message from the parent/wrong origin",
    );
    await frame
      .getByRole("button", { name: "Try top navigation and popup" })
      .click();
    await frame
      .locator("#isolation")
      .getByText(/fullscreenDenied/)
      .waitFor();
    const isolation = JSON.parse(await frame.locator("#isolation").innerText());
    assert(
      Object.values(isolation).every((value) => value === true),
      `Sandbox escape: ${JSON.stringify(isolation)}`,
    );
    assert(
      page.url() === validUrl,
      "Child escaped through top-level navigation",
    );
    await page
      .getByRole("button", { name: "Options for embedded", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Home control bottom right", exact: true })
      .click();
    const cornerBox = await page.locator(".viewer-home-controls").boundingBox();
    assert(
      cornerBox &&
        cornerBox.x + cornerBox.width <= width - 13 &&
        cornerBox.y + cornerBox.height <= height - 28,
      `${device}: alternate corner ignores safe areas`,
    );
    await home(page);
    await poll(
      async () =>
        await page
          .getByRole("button", { name: "Open embedded", exact: true })
          .evaluate((element) => document.activeElement === element),
      "Explicit Home did not restore app focus by ID",
    );
    assert(
      Math.abs(
        (await page
          .locator(".apps-home")
          .evaluate((element) => element.scrollTop)) - scroll,
      ) <= 1,
      `${device}: explicit Home lost scroll`,
    );
    await page.goBack();
    await page
      .getByRole("button", { name: "Jelly home", exact: true })
      .waitFor();
    await page.goForward();
    await page.getByRole("heading", { name: "Apps", exact: true }).waitFor();
    assert(
      fake.visits.get("embedded")?.size === 1,
      "Back/Forward counted the same navigation twice",
    );

    // Linked direct launch keeps Apps in the original tab and has no opener.
    const newPage = context.waitForEvent("page");
    await page
      .getByRole("button", { name: "Open linked", exact: true })
      .click();
    const popup = await newPage;
    await popup.waitForLoadState();
    assert(
      page.url() === `${jellyOrigin}/apps`,
      "Direct linked launch replaced Apps",
    );
    assert(
      await popup.evaluate(() => window.opener === null),
      "Direct launch exposes Jelly window.opener",
    );
    await popup.close();
    assert(
      fake.visits.get("linked")?.size === 1,
      "Direct launch not recorded once",
    );

    // Ordinary visits restore Apps; explicit conversation links still win.
    await page.goto(jellyOrigin);
    await page.getByRole("heading", { name: "Apps", exact: true }).waitFor();
    await page.goto(`${jellyOrigin}/agents/${agentId}`);
    await page.reload();
    await page
      .getByRole("textbox", { name: "Message Jelly", exact: true })
      .waitFor();
    await page
      .getByRole("textbox", { name: "Message Jelly", exact: true })
      .fill("Retained app-building draft");
    if (width < 768) {
      assert(
        await page.locator(".destination-navigation").isHidden(),
        "Deep-linked mobile chat exposes tabs",
      );
      await page.locator(".conversation-header .mobile-back").click();
      await poll(
        () => page.locator(".destination-navigation").isVisible(),
        "Deep-linked chat Back did not restore tabs",
      );
    }
    await page.getByRole("link", { name: "Apps", exact: true }).click();
    await page.getByRole("heading", { name: "Apps", exact: true }).waitFor();
    assert(
      (await page.locator(".agents-layer").getAttribute("inert")) !== null,
      "Inactive Agents layer not inert",
    );
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    if (width < 768) {
      await page
        .locator(".agents-layer .agent-row")
        .filter({ hasText: "Jelly" })
        .click();
      await page
        .getByRole("textbox", { name: "Message Jelly", exact: true })
        .waitFor();
    }
    assert(
      (await page
        .getByRole("textbox", { name: "Message Jelly", exact: true })
        .inputValue()) === "Retained app-building draft",
      "Destination switch lost draft",
    );
    assert(
      errors.length === 0,
      `${device}: browser errors ${errors.join("; ")}`,
    );
    await context.close();
    console.log(
      `PASS Apps launcher/viewer keyboard, layout, safe areas, bridge, sandbox, WebSocket, direct and routes: ${device}`,
    );
  }

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const fake = await fixtureApps(context);
  const page = await context.newPage();
  await page.goto(`${jellyOrigin}/apps/blocked`);
  await page
    .getByRole("button", { name: "Open in new tab", exact: true })
    .waitFor({ timeout: 12000 });
  assert(
    (await page.locator("iframe").count()) === 1,
    "Frame-denial fixture was not attempted",
  );
  assert(
    await page
      .getByRole("button", { name: "Jelly home", exact: true })
      .isVisible(),
    "Denied frame hid Jelly home",
  );
  const blockedNavigationId = fake.launches.find(
    (launch) => launch.appId === "blocked",
  )!.navigationId;
  await page.reload();
  await poll(
    () =>
      fake.launches.filter((launch) => launch.appId === "blocked").length >= 2,
    "Reload entry not recorded with shared navigation identity",
  );
  assert(
    fake.launches
      .filter((launch) => launch.appId === "blocked")
      .every((launch) => launch.navigationId === blockedNavigationId),
    "Reload changed navigation identity",
  );
  assert(fake.visits.get("blocked")?.size === 1, "Reload duplicated visit");
  await home(page);
  await page.getByRole("button", { name: "Open stopped", exact: true }).click();
  await page.getByText(/This app is stopped/).waitFor();
  assert(
    (await page.locator("iframe").count()) === 0,
    "Stopped app got a blank iframe",
  );
  await page.getByRole("button", { name: "Start app", exact: true }).click();
  await page.locator("iframe").waitFor();
  assert(
    fake.visits.get("stopped")?.size === 1,
    "Start/health update counted as a new launch",
  );
  await home(page);
  // Many iframe history entries cannot affect deterministic explicit Home.
  await page
    .getByRole("button", { name: "Open embedded", exact: true })
    .click();
  await page
    .frameLocator("iframe")
    .getByRole("button", { name: "Many internal navigations" })
    .click();
  await page.waitForURL(`${jellyOrigin}/apps/embedded/internal/3`);
  await home(page);
  assert(
    page.url() === `${jellyOrigin}/apps`,
    "Home used history.back through iframe history",
  );
  let releases = 0;
  await context.route("**/api/computer**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/release")) {
      releases++;
      if (releases === 1)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Fixture private handback failed" }),
        });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "starting",
        control: releases >= 2 ? "agent" : "human",
        owned: releases < 2,
        error: null,
      }),
    });
  });
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByTitle("Jelly · idle", { exact: true }).click();
  await page
    .getByRole("button", { name: "Agent options", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Computer", exact: true })
    .click();
  const privatePanel = page.getByRole("dialog", {
    name: "Agent computer",
    exact: true,
  });
  await privatePanel.getByText(/You have control/).waitFor();
  await page.evaluate(() => history.go(-2));
  await privatePanel
    .getByText(/requested destination will open after handback succeeds/)
    .waitFor();
  assert(
    page.url().startsWith(`${jellyOrigin}/agents`),
    "Back left private ComputerPanel under inert Apps layer",
  );
  assert(
    (await page.locator(".agents-layer").getAttribute("inert")) === null,
    "Private panel's ancestor became inert",
  );
  await privatePanel.getByRole("button", { name: "Close dialog" }).click();
  await privatePanel.getByText(/Fixture private handback failed/).waitFor();
  assert(
    releases === 1 && (await privatePanel.isVisible()),
    "Failed handback dismissed private panel",
  );
  await privatePanel.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("heading", { name: "Apps", exact: true }).waitFor();
  assert(
    Number(releases) === 2 && page.url() === `${jellyOrigin}/apps`,
    "Requested Apps destination did not resume after normal handback",
  );
  await context.close();
  console.log(
    "PASS frame denial, reload dedup, unavailable recovery, deterministic iframe home, and private handback navigation guard",
  );
} finally {
  await browser.close();
  appServer.stop(true);
  deniedServer.stop(true);
  frontendServer.stop(true);
  await jelly.close();
  rmSync(dir, { recursive: true, force: true });
}
