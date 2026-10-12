await import("./dom");
import { afterEach, expect, test } from "bun:test";
import { EventSource as NodeEventSource } from "eventsource";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppRecord, AppsCapabilities } from "../src/shared/apps";
import { AppsHome, sortApps } from "../src/client/AppsHome";
import { AppViewer, validateAppBridge } from "../src/client/AppViewer";
import { AppDetails, RemoveApp } from "../src/client/AppDetails";
import { App } from "../src/client/App";
import { appOrigin, appException } from "../src/client/app-origin";
import { readAppsLocation, safeAppRoute } from "../src/client/apps-navigation";
import { recordAppLaunch } from "../src/client/api";
import { startApp } from "./fixtures/app";
import { browserCookieFetch } from "./fixtures/control-session";
const { render, screen, fireEvent, waitFor, cleanup, act, within } =
  await import("@testing-library/react");
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalOpen = window.open;
let fixture: Awaited<ReturnType<typeof startApp>> | undefined;
let dir: string | undefined;
// The fixture explicitly verifies embedding; the current backend contract does
// not yet include that policy field, so its absence must remain fail-closed.
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
  warnings: ["Remote verification pending"],
};
function app(id: string, values: Partial<AppRecord> = {}): AppRecord {
  return {
    id,
    slug: id,
    name: id,
    description: "A private app",
    iconAssetId: null,
    projectId: null,
    builderAgentId: null,
    sourceDirectory: null,
    managementMode: "managed",
    launchMode: "embedded",
    runtimeSocket: null,
    gatewayPort: 8101,
    unitName: `jelly-app-${id}.service`,
    deploymentRevision: "release-1",
    executable: "/usr/bin/bun",
    args: [],
    healthPath: "/health",
    localOrigin: "http://127.0.0.1:8101",
    tailnetOrigin: "http://fixture.tailnet.test:8101",
    allowedJellyOrigins: ["http://localhost"],
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
function mockApps(
  records: AppRecord[],
  options: {
    star?: (id: string, starred: boolean) => Promise<AppRecord>;
    passthrough?: typeof fetch;
  } = {},
) {
  const calls: { path: string; method: string; data: any; headers: Headers }[] =
    [];
  let listCalls = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname;
    if (!path.startsWith("/api/apps") && path !== "/api/control-session") {
      if (options.passthrough) return options.passthrough(input, init);
      throw new Error(`Unexpected fixture request ${url}`);
    }
    const method = init?.method ?? "GET";
    const data = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path, method, data, headers: new Headers(init?.headers) });
    if (path === "/api/control-session")
      return options.passthrough
        ? options.passthrough(input, init)
        : Response.json({ csrf: "fixture-control-token" });
    if (path === "/api/apps/capabilities") return Response.json(capabilities);
    if (path === "/api/apps") {
      listCalls++;
      const q = url.searchParams.get("q") ?? "";
      const filtered = records.filter((record) =>
        `${record.name} ${record.description}`
          .toLowerCase()
          .includes(q.toLowerCase()),
      );
      const grouped = sortApps(filtered);
      const offset = Number(url.searchParams.get("after") ?? 0);
      const limit = 2;
      return Response.json({
        starred: grouped.starred,
        history: grouped.history.slice(offset, offset + limit),
        after:
          offset + limit < grouped.history.length
            ? String(offset + limit)
            : null,
        capabilities,
      });
    }
    const match = /^\/api\/apps\/([^/]+)(?:\/(.+))?$/.exec(path)!;
    const id = decodeURIComponent(match[1]!);
    const record = records.find((record) => record.id === id);
    if (!record)
      return Response.json({ error: "App not found." }, { status: 404 });
    if (match[2] === "star") {
      if (!new Headers(init?.headers).get("x-jelly-csrf"))
        throw new Error("Missing CSRF");
      try {
        const updated = options.star
          ? await options.star(id, data.starred)
          : {
              ...record,
              starredAt: data.starred
                ? (record.starredAt ?? new Date().toISOString())
                : null,
            };
        Object.assign(record, updated);
        return Response.json(updated);
      } catch (error) {
        return Response.json(
          { error: (error as Error).message },
          { status: 503 },
        );
      }
    }
    if (match[2] === "launch") {
      record.lastOpenedAt = new Date().toISOString();
      return Response.json(record);
    }
    if (match[2] === "logs")
      return Response.json({
        text: "service started\nsecret=[redacted]",
        warning: "Best effort redaction only",
      });
    if (match[2] === "icon")
      return Response.json({ ...record, iconAssetId: "new-icon" });
    return Response.json(record);
  }) as typeof fetch;
  return { calls, listCalls: () => listCalls };
}
const homeProps = {
  active: true,
  focusAppId: null,
  revision: 0,
  changedApp: null,
  onCapabilities() {},
  onLaunch() {},
  onDetails() {},
  onEdit() {},
  onBuild() {},
  onControl() {},
  onRemove() {},
};
const viewerProps = {
  appId: "viewer",
  navigationId: "client-viewer",
  route: "/",
  capabilities,
  changedApp: null,
  revision: 0,
  onHome() {},
  onChanged() {},
  onCapabilities() {},
  onRoute() {},
  onDetails() {},
  onNewTab() {},
  onEdit() {},
  onControl() {},
  onRemove() {},
};
afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  window.open = originalOpen;
  localStorage.clear();
  window.location.href = "http://localhost/";
  window.history.replaceState(null, "", "/");
  if (fixture) await fixture.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  fixture = undefined;
  dir = undefined;
});

test("Apps routes prefer explicit app/chat links; bridge paths cannot contain tokens or escaped navigation", () => {
  for (const path of ["/", "/tasks/123", "/caf%C3%A9"])
    expect(safeAppRoute(path)).toBe(true);
  for (const path of [
    "https://elsewhere.test",
    "//evil.test",
    "/a?token=secret",
    "/a#token",
    "/a\\b",
    "/../x",
    "/a/./b",
    "/%2e%2e/x",
    "/%2f%2fevil",
    "/%5c",
    "/%252f",
    "/%3fkey",
    "/%23hash",
    "/%00",
    "/%20",
    "/x\n",
    "/%zz",
  ])
    expect(safeAppRoute(path)).toBe(false);
  window.history.replaceState(null, "", "/apps/viewer/tasks/123");
  const first = readAppsLocation();
  expect(first.destination).toBe("viewer");
  expect(first.route).toBe("/tasks/123");
  expect(readAppsLocation().navigationId).toBe(first.navigationId);
  window.history.replaceState(null, "", "/agents/builder");
  expect(readAppsLocation().agentId).toBe("builder");
  window.history.replaceState(null, "", "/?agentId=query-builder");
  expect(readAppsLocation().explicit).toBe(true);
  expect(readAppsLocation().destination).toBe("agents");
});

test("Apps sorting is starred-first, stable and independent of opening or renaming favorites", () => {
  const old = "2026-01-01T01:00:00.000Z",
    recent = "2026-02-01T01:00:00.000Z";
  const records = [
    app("b", { starredAt: old, lastOpenedAt: recent }),
    app("a", { starredAt: old }),
    app("c", { starredAt: recent }),
    app("new", { createdAt: recent }),
    app("opened", { lastOpenedAt: recent }),
    app("old"),
  ];
  expect(sortApps(records).starred.map((record) => record.id)).toEqual([
    "c",
    "a",
    "b",
  ]);
  expect(sortApps(records).history.map((record) => record.id)).toEqual([
    "new",
    "opened",
    "old",
  ]);
  records[0]!.name = "Renamed";
  expect(sortApps(records).starred.map((record) => record.id)).toEqual([
    "c",
    "a",
    "b",
  ]);
});

test("AppsHome optimistic stars move keyboard focus, roll back with an announcement, and retry without launching", async () => {
  let reject!: (error: Error) => void;
  let attempt = 0,
    launches = 0;
  const record = app("Notes");
  const mock = mockApps([record], {
    star: async (_id, starred) => {
      attempt++;
      if (attempt === 1)
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      return {
        ...record,
        starredAt: starred ? "2026-02-01T00:00:00.000Z" : null,
      };
    },
  });
  render(<AppsHome {...homeProps} onLaunch={() => launches++} />);
  const star = await screen.findByRole("button", { name: "Star Notes" });
  star.focus();
  fireEvent.click(star);
  const unstar = await screen.findByRole("button", { name: "Unstar Notes" });
  expect(unstar.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(unstar);
  expect(
    document.querySelector(".apps-starred-grid [data-app-id='Notes']"),
  ).not.toBeNull();
  expect(
    document.querySelector(".apps-history-row[data-app-id='Notes']"),
  ).toBeNull();
  await act(async () => {
    reject(new Error("Save unavailable"));
  });
  const restored = await screen.findByRole("button", { name: "Star Notes" });
  expect(document.activeElement).toBe(restored);
  expect(restored.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("status").textContent).toContain(
    "Previous state restored",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry star for Notes" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Unstar Notes" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  expect(document.activeElement?.id).toBe("jelly-app-Notes-star");
  expect(launches).toBe(0);
  expect(
    mock.calls
      .filter((call) => call.path.endsWith("/star"))
      .every((call) => !!call.headers.get("x-jelly-csrf")),
  ).toBe(true);
});

test("AppsHome pagination, search grouping and empty sections stay lightweight", async () => {
  mockApps([
    app("Star", { starredAt: "2026-02-01T00:00:00.000Z" }),
    app("First", { createdAt: "2026-03-01T00:00:00.000Z" }),
    app("Second"),
    app("Third"),
  ]);
  render(<AppsHome {...homeProps} />);
  await screen.findByRole("button", { name: "Open First" });
  expect(screen.queryByRole("button", { name: "Open Third" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more apps" }));
  await screen.findByRole("button", { name: "Open Third" });
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Star" },
  });
  await waitFor(() =>
    expect(!!screen.queryByRole("button", { name: "Open First" })).toBe(false),
  );
  expect(screen.getByRole("heading", { name: "Starred" })).toBeDefined();
  expect(screen.queryByRole("heading", { name: "History" })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "nothing" },
  });
  await screen.findByText("No apps match your search.");
});

test("AppsHome launch updates reorder History but never favorite order, and deterministic home focuses by ID", async () => {
  const first = app("first", { createdAt: "2026-02-01T00:00:00.000Z" }),
    last = app("last");
  mockApps([first, last]);
  const ui = render(<AppsHome {...homeProps} />);
  await screen.findByRole("button", { name: "Open last" });
  ui.rerender(
    <AppsHome
      {...homeProps}
      focusAppId="last"
      changedApp={{ ...last, lastOpenedAt: "2026-03-01T00:00:00.000Z" }}
    />,
  );
  await waitFor(() =>
    expect(
      document
        .querySelector(".apps-history-list li")
        ?.getAttribute("data-app-id"),
    ).toBe("last"),
  );
  expect(document.activeElement?.id).toBe("jelly-app-last-launch");
});

test("AppViewer rejects wrong origins, windows, identity and schema; frame load alone proves nothing", async () => {
  const source = {} as Window;
  const valid = { type: "jelly:route", appId: "viewer", route: "/tasks/1" };
  expect(
    validateAppBridge(
      { data: valid, origin: "http://app.test", source },
      "viewer",
      "http://app.test",
      source,
    ),
  ).toEqual({ type: "jelly:route", route: "/tasks/1" });
  for (const data of [
    { ...valid, appId: "other" },
    { ...valid, token: "secret" },
    { ...valid, route: "/?token=secret" },
    { type: "jelly:ready", appId: "viewer", route: "/" },
    null,
    [],
  ])
    expect(
      validateAppBridge(
        { data, origin: "http://app.test", source },
        "viewer",
        "http://app.test",
        source,
      ),
    ).toBeNull();
  expect(
    validateAppBridge(
      { data: valid, origin: "http://evil.test", source },
      "viewer",
      "http://app.test",
      source,
    ),
  ).toBeNull();
  expect(
    validateAppBridge(
      { data: valid, origin: "http://app.test", source: {} as Window },
      "viewer",
      "http://app.test",
      source,
    ),
  ).toBeNull();
  const mock = mockApps([app("viewer")]);
  let reported = "";
  render(
    <AppViewer
      {...viewerProps}
      onRoute={(route) => {
        reported = route;
      }}
    />,
  );
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  const iframe = document.querySelector("iframe")!;
  expect(iframe.getAttribute("sandbox")).toBe(
    "allow-scripts allow-forms allow-same-origin",
  );
  expect(iframe.getAttribute("allow")).toContain("fullscreen 'none'");
  fireEvent.load(iframe);
  await waitFor(() =>
    expect(
      mock.calls.filter((call) => call.path.endsWith("/launch")),
    ).toHaveLength(1),
  );
  act(() =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: valid,
        origin: "http://127.0.0.1:8101",
        source: iframe.contentWindow,
      }),
    ),
  );
  expect(reported).toBe("/tasks/1");
  expect(
    mock.calls.filter((call) => call.path.endsWith("/launch")),
  ).toHaveLength(1);
  expect(iframe.getAttribute("src")).toBe("http://127.0.0.1:8101/");
});

test("Shared navigation ID deduplicates tile, viewer, direct fallback, and failed launches remain retryable", async () => {
  const mock = mockApps([app("dedup")]);
  await Promise.all([
    recordAppLaunch("dedup", "same-visit"),
    recordAppLaunch("dedup", "same-visit"),
  ]);
  await recordAppLaunch("dedup", "same-visit");
  expect(
    mock.calls.filter((call) => call.path.endsWith("/launch")),
  ).toHaveLength(1);
  await recordAppLaunch("dedup", "another-visit");
  expect(
    mock.calls.filter((call) => call.path.endsWith("/launch")),
  ).toHaveLength(2);
});

test("Remote devices never get loopback, same-origin or credential-bearing app addresses; HTTPS never embeds HTTP", async () => {
  const record = app("mixed");
  expect(
    appOrigin(record, {
      hostname: "phone.tailnet.test",
      origin: "https://phone.tailnet.test",
    } as Location),
  ).toBe(record.tailnetOrigin);
  expect(
    appOrigin({ ...record, tailnetOrigin: null }, {
      hostname: "phone.tailnet.test",
      origin: "https://phone.tailnet.test",
    } as Location),
  ).toBeNull();
  expect(appOrigin({ ...record, localOrigin: "http://localhost" })).toBeNull();
  for (const value of [
    "http://user:secret@127.0.0.1:8101",
    "http://127.0.0.1:8101/?token=secret",
    "javascript:alert(1)",
  ])
    expect(appOrigin({ ...record, localOrigin: value })).toBeNull();
  const tailnetDown = {
    ...record,
    observation: { ...record.observation, tailnetReachable: false },
  };
  expect(appException(tailnetDown)).toBeNull();
  window.location.href = "http://phone.tailnet.test/apps/mixed";
  expect(appException(tailnetDown)).toBe("Tailnet unavailable");
  window.location.href = "https://localhost/apps/mixed";
  mockApps([record]);
  render(
    <AppViewer {...viewerProps} appId="mixed" navigationId="mixed-visit" />,
  );
  await screen.findByText(/HTTPS Jelly cannot embed/);
  expect(document.querySelector("iframe")).toBeNull();
  expect(screen.getByRole("button", { name: "Open in new tab" })).toBeDefined();
});

test("Details sanitizes technical URLs, offers bounded diagnostics and rejects SVG icon uploads", async () => {
  const record = app("Details", {
    localOrigin: "http://user:secret@127.0.0.1:8101/?token=private",
    builderAgentId: "removed-agent",
  });
  const mock = mockApps([record]);
  let savedIcon = "";
  render(
    <AppDetails
      app={record}
      capabilities={capabilities}
      agents={[]}
      projects={[]}
      onClose={() => {}}
      onAgent={() => {}}
      onNewTab={() => {}}
      onEdit={() => {}}
      onControl={() => {}}
      onRemove={() => {}}
      onChanged={(record) => {
        savedIcon = record.iconAssetId ?? "";
      }}
    />,
  );
  expect(screen.queryByText(/user:secret/)).toBeNull();
  expect(screen.getByText(/Agent unavailable/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Load diagnostics" }));
  await screen.findByText("Best effort redaction only");
  expect(screen.getByText(/secret=\[redacted\]/)).toBeDefined();
  fireEvent.change(screen.getByLabelText(/Choose app icon/), {
    target: {
      files: [
        new window.File(["<svg/>"], "unsafe.svg", { type: "image/svg+xml" }),
      ],
    },
  });
  await screen.findByText(/SVG is not supported/);
  expect(mock.calls.some((call) => call.path.endsWith("/icon"))).toBe(false);
  fireEvent.change(screen.getByLabelText(/Choose app icon/), {
    target: {
      files: [
        new window.File(["raster-fixture"], "safe.png", { type: "image/png" }),
      ],
    },
  });
  await waitFor(() => expect(savedIcon).toBe("new-icon"));
  const upload = mock.calls.find((call) => call.path.endsWith("/icon"))!;
  expect(upload.headers.get("Content-Type")).toBe("image/png");
  expect(!!upload.headers.get("x-jelly-csrf")).toBe(true);
});

test("Apps/Agents switching preserves the mounted selected project, draft and chat DOM; Build prepares an unsent draft", async () => {
  dir = mkdtempSync(join(tmpdir(), "jelly-apps-client-"));
  fixture = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  const project = fixture.service.saveProject(null, {
    name: "App project",
    defaultCwd: dir,
  });
  const agent = fixture.store.agents()[0]!;
  fixture.service.moveAgent(agent.id, project.id);
  const origin = fixture.server.url.origin;
  const passthrough = browserCookieFetch(origin, originalFetch);
  mockApps([app("Example")], { passthrough });
  globalThis.EventSource = class extends NodeEventSource {
    constructor(url: string) {
      super(new URL(url, origin), { fetch: passthrough });
    }
  } as unknown as typeof EventSource;
  window.history.replaceState(null, "", `/agents/${agent.id}`);
  render(<App />);
  const input = await screen.findByRole("textbox", {
    name: `Message ${agent.name}`,
  });
  fireEvent.change(input, { target: { value: "My existing unsent draft" } });
  const chat = document.querySelector(".conversation")!;
  Object.defineProperty(chat, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(chat, "clientHeight", {
    configurable: true,
    value: 300,
  });
  chat.scrollTop = 42;
  const beforeRuns = fixture.store.runs(agent.id).length;
  fireEvent.click(screen.getByRole("link", { name: "Apps" }));
  await screen.findByRole("button", { name: "Open Example" });
  expect(document.querySelector(".agents-layer")?.hasAttribute("inert")).toBe(
    true,
  );
  expect(document.querySelector(".conversation")).toBe(chat);
  expect((input as HTMLTextAreaElement).value).toBe("My existing unsent draft");
  fixture.service.emit(agent.id, null, "message", {
    role: "assistant",
    text: "Work completed while Apps was open",
  });
  await waitFor(() =>
    expect(
      !!document.querySelector(".agents-layer .agent-indicator.unread"),
    ).toBe(true),
  );
  expect(
    JSON.parse(
      localStorage.getItem(`jelly.read.${fixture.store.instance().id}`) ?? "{}",
    )[agent.id],
  ).toBeUndefined();
  fireEvent.click(screen.getByRole("link", { name: "Agents" }));
  await screen.findByRole("textbox", { name: `Message ${agent.name}` });
  expect(chat.scrollTop).toBe(42);
  expect(
    document.querySelector(".inbox-stack")?.classList.contains("in-project"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
  await waitFor(() =>
    expect(
      !!document.querySelector(".agents-layer .agent-indicator.unread"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("link", { name: "Apps" }));
  fireEvent.click(screen.getByRole("button", { name: "Build an app" }));
  const dialog = await screen.findByRole("dialog", { name: "Build an app" });
  fireEvent.change(within(dialog).getByLabelText("Project"), {
    target: { value: project.id },
  });
  fireEvent.change(within(dialog).getByLabelText("Agent"), {
    target: { value: agent.id },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Prepare draft" }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: `Message ${agent.name}`,
        }) as HTMLTextAreaElement
      ).value,
    ).toContain("My existing unsent draft\n\nI'd like to build"),
  );
  expect(fixture.store.runs(agent.id)).toHaveLength(beforeRuns);
  const count = fixture.store.agents().length;
  fireEvent.click(screen.getByRole("link", { name: "Apps" }));
  fireEvent.click(screen.getByRole("button", { name: "Build an app" }));
  const createDialog = await screen.findByRole("dialog", {
    name: "Build an app",
  });
  fireEvent.change(within(createDialog).getByLabelText("Project"), {
    target: { value: project.id },
  });
  fireEvent.click(
    within(createDialog).getByRole("button", { name: "Prepare draft" }),
  );
  await waitFor(() => expect(fixture!.store.agents().length).toBe(count + 1));
  const created = fixture.store.agents().find((item) => item.id !== agent.id)!;
  expect(created.projectId).toBe(project.id);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message New Agent",
        }) as HTMLTextAreaElement
      ).value,
    ).toContain("I'd like to build a persistent app"),
  );
  expect(fixture.store.runs(created.id)).toHaveLength(0);
}, 15000);

test("Browser destination navigation defers during private ComputerPanel handback, keeps failures open, then resumes Apps", async () => {
  dir = mkdtempSync(join(tmpdir(), "jelly-apps-private-"));
  fixture = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  const origin = fixture.server.url.origin;
  const agent = fixture.store.agents()[0]!;
  const passthrough = browserCookieFetch(origin, originalFetch);
  mockApps([app("Private-safe")], { passthrough });
  const appsFetch = globalThis.fetch;
  let releases = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const path = new URL(String(input), origin).pathname;
    if (path.startsWith("/api/computer")) {
      if (path.endsWith("/release")) {
        releases++;
        if (releases === 1)
          return Response.json(
            { error: "Fixture handback failed" },
            { status: 503 },
          );
      }
      return Response.json({
        status: "starting",
        control: releases >= 2 ? "agent" : "human",
        owned: releases < 2,
        error: null,
      });
    }
    return appsFetch(input, init);
  }) as typeof fetch;
  globalThis.EventSource = class extends NodeEventSource {
    constructor(url: string) {
      super(new URL(url, origin), { fetch: passthrough });
    }
  } as unknown as typeof EventSource;
  window.history.replaceState(null, "", `/agents/${agent.id}`);
  render(<App />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Computer" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Computer" }));
  const panel = await screen.findByRole("dialog", { name: "Agent computer" });
  await within(panel).findByText(/You have control/);
  act(() => {
    window.history.pushState({ jellyDestination: "apps" }, "", "/apps");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  expect(window.location.pathname).toBe(`/agents/${agent.id}`);
  expect(document.querySelector(".agents-layer")?.hasAttribute("inert")).toBe(
    false,
  );
  await within(panel).findByText(
    /requested destination will open after handback succeeds/,
  );
  fireEvent.click(within(panel).getByRole("button", { name: "Close dialog" }));
  await within(panel).findByText(/Fixture handback failed/);
  expect(releases).toBe(1);
  expect(window.location.pathname).toBe(`/agents/${agent.id}`);
  fireEvent.click(within(panel).getByRole("button", { name: "Close dialog" }));
  await screen.findByRole("button", { name: "Open Private-safe" });
  expect(releases).toBe(2);
  expect(window.location.pathname).toBe("/apps");
  expect(!!screen.queryByRole("dialog", { name: "Agent computer" })).toBe(
    false,
  );
}, 15000);

test("Removing an app unregisters by default; uninstall is separate and linked apps have no service controls", async () => {
  const managed = app("Remove-managed"),
    linked = app("Remove-linked", {
      managementMode: "linked",
      launchMode: "direct",
    });
  const mock = mockApps([managed, linked]);
  let removed = 0;
  let ui = render(
    <RemoveApp app={managed} onClose={() => {}} onRemoved={() => removed++} />,
  );
  expect(screen.getByText(/service will continue running/)).toBeDefined();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove from Apps" }));
  await waitFor(() => expect(removed).toBe(1));
  expect(
    mock.calls.find((call) => call.path.endsWith("/remove"))?.data,
  ).toEqual({ uninstall: false });
  ui.unmount();
  ui = render(
    <RemoveApp app={linked} onClose={() => {}} onRemoved={() => removed++} />,
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText(/does not own this service/)).toBeDefined();
  ui.unmount();
  render(
    <AppDetails
      app={linked}
      capabilities={capabilities}
      agents={[]}
      projects={[]}
      onClose={() => {}}
      onAgent={() => {}}
      onNewTab={() => {}}
      onEdit={() => {}}
      onControl={() => {}}
      onRemove={() => {}}
      onChanged={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("Unsupported embedding applies to linked apps too, and direct fallback discloses backend security limitations", async () => {
  const record = app("unsafe-linked", {
    managementMode: "linked",
    launchMode: "embedded",
  });
  mockApps([record]);
  const unsupported = {
    ...capabilities,
    embedding: false,
    warnings: [
      "JavaScript cookies are not isolated by ports. Direct launch is not a cookie-isolation solution.",
    ],
  };
  render(
    <AppViewer
      {...viewerProps}
      appId={record.id}
      navigationId="unsafe-linked-visit"
      capabilities={unsupported}
    />,
  );
  await screen.findByText(/Direct launch is not a cookie-isolation solution/);
  expect(document.querySelector("iframe")).toBeNull();
  expect(screen.getByRole("button", { name: "Open in new tab" })).toBeDefined();
});

test("Actual backend capabilities without an embedding policy fail closed without declaring deployment unsupported", async () => {
  const record = app("unverified-managed");
  mockApps([record]);
  const actualShape = { ...capabilities };
  delete (actualShape as Partial<AppsCapabilities>).embedding;
  render(
    <AppViewer
      {...viewerProps}
      appId={record.id}
      navigationId="unverified-managed-visit"
      capabilities={actualShape}
    />,
  );
  await screen.findByText(/Embedding has not been verified/);
  expect(document.querySelector("iframe")).toBeNull();
  expect(actualShape.supported).toBe(true);
  expect(actualShape.managedDeployment).toBe(true);
});
