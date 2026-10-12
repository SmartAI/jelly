import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TObject } from "typebox";
import { tmpdir } from "node:os";
import {
  APPS_INSTRUCTIONS,
  appsTools,
  instanceInfoTool,
  type AppsToolsService,
} from "../src/server/apps-tools";
import { Harness } from "../src/server/harness";
import { Store } from "../src/server/store";
import { SessionWork } from "../src/server/session-work";
import { fixtureModel, fixtureStream } from "./fixtures/model";
import { installJellyBridge } from "../templates/apps/jelly-bridge.mjs";

const capabilities = {
  supported: true,
  platform: "linux",
  managedDeployment: true,
  systemd: true,
  lingering: true,
  tailscale: false,
  tailnetAddresses: [],
  tailnetHostname: null,
  gatewayNode: true,
  gatewayNodeVersion: "22.0.0",
  privateHttps: false as const,
  cookieIsolation: "http-only-prefixed" as const,
  warnings: ["Remote verification pending; no built-in private HTTPS."],
};
const app = {
  id: "fixture-app",
  slug: "fixture-app",
  name: "Fixture",
  description: "Test app",
  iconAssetId: null,
  projectId: "original-project",
  builderAgentId: "original-builder",
  sourceDirectory: "/fixture/source",
  managementMode: "managed" as const,
  launchMode: "embedded" as const,
  runtimeSocket: null,
  gatewayPort: 23002,
  unitName: "jelly-app-fixture-app.service",
  deploymentRevision: "release-1",
  executable: "/fixture/bun",
  args: ["server.ts"],
  healthPath: "/health",
  localOrigin: "http://127.0.0.1:23002",
  tailnetOrigin: null,
  allowedJellyOrigins: ["http://127.0.0.1:5173"],
  desiredState: "ready" as const,
  starredAt: null,
  lastOpenedAt: null,
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
  viewerCorner: "top-left" as const,
  observation: {
    serviceState: "running" as const,
    httpHealthy: true,
    checkedAt: "2026-10-11T00:00:00.000Z",
    tailnetReachable: null as boolean | null,
    lastError: null,
  },
};
const identity = {
  id: "builder-agent",
  name: "Builder",
  projectId: "builder-project",
};
const deployment = {
  app,
  viewerUrl: "/apps/fixture-app",
  localUrl: app.localOrigin,
  tailnetUrl: null,
  unitName: app.unitName,
  health: app.observation,
  remoteVerificationPending: true,
};
function fixture() {
  const service = {
    list: mock((_query?: unknown) => ({
      starred: [],
      history: [app],
      after: null,
      capabilities,
    })),
    get: mock((_id: string) => app),
    register: mock((_input: unknown, _defaults?: unknown) => app),
    setStarred: mock((_id: string, _starred: boolean) => ({
      ...app,
      starredAt: "2026-10-11T01:00:00.000Z",
    })),
    capabilities: mock(async () => capabilities),
    deploy: mock(async (_manifest: unknown, _defaults?: unknown) => app),
    control: mock(async (_id: string, _action: string) => app),
    logs: mock(async (_id: string, _limit?: number) => ({
      text: "safe diagnostic",
      warning: "Never log secrets.",
    })),
    remove: mock(async (_id: string, options: { uninstall: boolean }) => ({
      removed: true,
      serviceRetained: !options.uninstall,
      dataRetained: true,
    })),
  };
  // The fake has no systemd/network effects; integration tests exercise the real service separately.
  const tools = appsTools(service as unknown as AppsToolsService, identity);
  return {
    service,
    tools,
    call: (name: string, input: unknown, signal?: AbortSignal) =>
      tools
        .find((tool) => tool.name === name)!
        .execute("test", input, signal, undefined, {} as ExtensionContext),
  };
}
function data(value: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  const content = value.content[0]!;
  if (content.type !== "text") throw new Error("Expected text result");
  return JSON.parse(content.text);
}

test("apps tools expose all operations with closed object schemas and explicit lifecycle choices", () => {
  const { tools } = fixture();
  expect(tools.map((tool) => tool.name)).toEqual([
    "apps_list",
    "apps_get",
    "apps_register",
    "apps_set_starred",
    "apps_deploy",
    "apps_control",
    "apps_logs",
    "apps_remove",
  ]);
  for (const tool of tools)
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  const schema = (name: string) =>
    tools.find((tool) => tool.name === name)!.parameters as TObject;
  const deploy = schema("apps_deploy");
  expect(deploy.required).toEqual(
    expect.arrayContaining([
      "name",
      "sourceDirectory",
      "executable",
      "args",
      "test",
    ]),
  );
  expect(deploy.properties.test).toMatchObject({
    additionalProperties: false,
    required: ["executable", "args"],
  });
  for (const forbidden of [
    "environment",
    "secrets",
    "runtimePort",
    "gatewayPort",
    "unitName",
    "shell",
    "starredAt",
    "lastOpenedAt",
  ])
    expect(deploy.properties[forbidden]).toBeUndefined();
  expect(
    schema("apps_register").properties.allowedJellyOrigins,
  ).toBeUndefined();
  expect(schema("apps_list")).toMatchObject({
    properties: {
      limit: { default: 30, maximum: 100 },
      after: { maxLength: 2000 },
    },
  });
  expect(deploy).toMatchObject({
    properties: {
      args: { maxItems: 100 },
      environmentFiles: { maxItems: 20 },
      healthPath: { maxLength: 512 },
    },
  });
  expect(schema("apps_remove").required).toContain("uninstall");
  expect(schema("apps_logs")).toMatchObject({
    properties: { limit: { maximum: 500 } },
  });
});

test("reads return registry, viewer URL and current capabilities without stars or launches", async () => {
  const f = fixture();
  expect(
    data(
      await f.call("apps_list", { q: "fixture", after: "cursor", limit: 25 }),
    ),
  ).toEqual({ starred: [], history: [app], after: null, capabilities });
  expect(f.service.list).toHaveBeenCalledWith({
    q: "fixture",
    after: "cursor",
    limit: 25,
  });
  expect(data(await f.call("apps_get", { id: app.id }))).toEqual({
    app,
    viewerUrl: "/apps/fixture-app",
    capabilities,
  });
  expect(f.service.get).toHaveBeenCalledWith(app.id);
  expect(f.service.setStarred).not.toHaveBeenCalled();
  expect(f.service.deploy).not.toHaveBeenCalled();
});

test("register/deploy pass builder/project insertion defaults separately without overwriting inputs", async () => {
  const f = fixture();
  const registration = {
    id: app.id,
    name: "Updated",
    builderAgentId: "explicit-builder",
    projectId: null,
    launchMode: "direct",
  };
  expect(data(await f.call("apps_register", registration))).toEqual(app);
  expect(f.service.register).toHaveBeenCalledWith(registration, {
    builderAgentId: identity.id,
    projectId: identity.projectId,
  });
  const manifest = {
    id: app.id,
    name: "Fixture",
    sourceDirectory: "/fixture/source",
    executable: "/fixture/bun",
    args: ["server.ts", "{socket}", "{dataDir}"],
    test: { executable: "/fixture/bun", args: ["test", "app.test.ts"] },
    environmentFiles: ["/fixture/private.env"],
    migrationPlan: "Back up durable data; no schema change.",
  };
  expect(data(await f.call("apps_deploy", manifest))).toEqual(deployment);
  expect(f.service.deploy).toHaveBeenCalledWith(manifest, {
    builderAgentId: identity.id,
    projectId: identity.projectId,
  });
  expect(f.service.setStarred).not.toHaveBeenCalled();
  expect(f.service.list).not.toHaveBeenCalled(); // No racy tool-side ownership lookup/slug normalization.
});

test("apps_deploy enriches the backend AppRecord without inventing checked health or remote success", async () => {
  const f = fixture();
  for (const tailnetReachable of [null, false, true]) {
    const observed = {
      ...app,
      observation: { ...app.observation, tailnetReachable },
    };
    f.service.deploy.mockResolvedValueOnce(observed);
    const value = data(await f.call("apps_deploy", {}));
    expect(value.app).toEqual(observed);
    expect(value.health).toEqual(observed.observation);
    expect(value.remoteVerificationPending).toBe(tailnetReachable === null);
  }
});
test("star/control/logs/remove delegate exactly and do not invent lifecycle behavior", async () => {
  const f = fixture();
  await f.call("apps_set_starred", { id: app.id, starred: false });
  expect(f.service.setStarred).toHaveBeenCalledWith(app.id, false);
  for (const action of ["start", "stop", "restart"]) {
    expect(data(await f.call("apps_control", { id: app.id, action }))).toEqual(
      app,
    );
    expect(f.service.control).toHaveBeenLastCalledWith(app.id, action);
  }
  expect(data(await f.call("apps_logs", { id: app.id, limit: 20 }))).toEqual({
    text: "safe diagnostic",
    warning: "Never log secrets.",
  });
  expect(f.service.logs).toHaveBeenCalledWith(app.id, 20);
  for (const uninstall of [false, true]) {
    expect(
      data(await f.call("apps_remove", { id: app.id, uninstall })),
    ).toEqual({
      removed: true,
      serviceRetained: !uninstall,
      dataRetained: true,
    });
    expect(f.service.remove).toHaveBeenLastCalledWith(app.id, { uninstall });
  }
  expect(f.service.deploy).not.toHaveBeenCalled();
});

test("aborted tool calls have no effects and unsupported service failures remain failures", async () => {
  const f = fixture();
  const signal = AbortSignal.abort(new Error("Cancelled"));
  for (const tool of f.tools)
    await expect(f.call(tool.name, {}, signal)).rejects.toThrow("Cancelled");
  for (const method of Object.values(f.service))
    expect(method).not.toHaveBeenCalled();
  f.service.deploy.mockRejectedValueOnce(
    new Error("Managed deployment unsupported"),
  );
  await expect(f.call("apps_deploy", {})).rejects.toThrow(
    "Managed deployment unsupported",
  );
});

test("instance_info reports safe current capabilities and the Apps Home destination", async () => {
  const f = fixture();
  const tool = instanceInfoTool(
    { id: "instance", name: "Test" },
    identity,
    f.service as unknown as AppsToolsService,
  );
  const value = data(
    await tool.execute(
      "test",
      {},
      undefined,
      undefined,
      {} as ExtensionContext,
    ),
  );
  expect(value).toEqual({
    instance: { id: "instance", name: "Test" },
    agent: identity,
    runtime: "Pi",
    storage: "SQLite",
    apps: { homeUrl: "/apps", capabilities },
  });
  expect(f.service.capabilities).toHaveBeenCalledTimes(1);
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
test("real Pi Apps composition with fake unrelated subagent RPC readiness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jelly-apps-agent-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(
    join(directory, "test.sqlite"),
    join(directory, "workspaces"),
  );
  cleanups.push(() => store.close());
  const agent = store.addAgent({
    name: "Builder",
    instructions: "Build thoughtfully",
    color: "#ffffff",
  });
  const previousPi = process.env.PI_CODING_AGENT_DIR;
  const previousRoot = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
  process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
  process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = resolve(
    "node_modules/@earendil-works/pi-coding-agent",
  );
  cleanups.push(() => {
    if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPi;
    if (previousRoot === undefined)
      delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
    else process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = previousRoot;
  });
  const harness = await Harness.create(
    join(directory, "pi"),
    undefined,
    join(directory, "config"),
  );
  harness.runtime.registerProvider("openai", {
    api: "openai-responses",
    baseUrl: fixtureModel.baseUrl,
    apiKey: "test-only-not-a-real-key",
    models: [fixtureModel],
    streamSimple: fixtureStream(1),
  });
  cleanups.push(() => harness.chatgptTransport.close());
  const f = fixture();
  // Apps composition is independent of subagent transport. Real subagent RPC stays covered by its existing suites.
  const readiness = spyOn(SessionWork.prototype, "rpc").mockImplementation(
    async (method) => {
      if (method === "ping") return { methods: ["status"] };
      if (method === "status")
        return { asyncSnapshot: { version: 1, runs: [] } };
      throw new Error(`Unexpected fake subagent RPC: ${method}`);
    },
  );
  cleanups.push(() => readiness.mockRestore());
  const session = await harness.create(
    agent,
    [],
    harness.config("api"),
    store.instance(),
    f.tools,
    undefined,
    null,
    undefined,
    f.service as unknown as Parameters<Harness["create"]>[8],
  );
  cleanups.push(() => harness.dispose(session));
  expect(readiness).toHaveBeenCalledWith("ping");
  expect(session.systemPrompt).toContain(APPS_INSTRUCTIONS);
  expect(session.getActiveToolNames()).toEqual(
    expect.arrayContaining(f.tools.map((tool) => tool.name)),
  );
  const info = session.agent.state.tools.find(
    (tool) => tool.name === "instance_info",
  )!;
  const value = data(
    await info.execute("test", {}, new AbortController().signal),
  );
  expect(value.apps).toEqual({ homeUrl: "/apps", capabilities });
  expect(f.service.capabilities).toHaveBeenCalledTimes(1);
  expect(f.service.deploy).not.toHaveBeenCalled();
}, 15000);

function bridgeFixture(
  remote = false,
  standalone = false,
  allowedOrigins = ["http://127.0.0.1:5173", "http://fixture.ts.net:5173"],
) {
  const sent = mock((_message: unknown, _origin: string) => {});
  const parent = { postMessage: sent };
  const listeners = new Map<string, (event: unknown) => void>();
  const home = {
    hidden: false,
    href: "",
    textContent: "Jelly Apps",
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
      if (name === "href") this.href = "";
    },
  };
  const win = {
    parent,
    location: { hostname: remote ? "fixture.ts.net" : "127.0.0.1" },
    addEventListener(name: string, fn: (event: unknown) => void) {
      listeners.set(name, fn);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
  };
  if (standalone) win.parent = win as unknown as typeof parent;
  const bridge = installJellyBridge({
    appId: app.id,
    allowedOrigins,
    homeLink: home as unknown as HTMLAnchorElement,
    win: win as unknown as Window,
  });
  return {
    bridge,
    home,
    win,
    parent,
    sent,
    message: (event: unknown) => listeners.get("message")?.(event),
  };
}
test("direct template visits cannot hide home via self messages or hand remote clients a loopback return URL", () => {
  const direct = bridgeFixture(false, true);
  direct.message({
    origin: "http://127.0.0.1:5173",
    source: direct.win,
    data: { type: "jelly:viewer", appId: app.id },
  });
  expect(direct.home.hidden).toBe(false);
  expect(direct.sent).not.toHaveBeenCalled();
  const remote = bridgeFixture(true, false, ["http://127.0.0.1:5173"]);
  expect(remote.home.href).toBe("");
  expect(remote.home.attributes.get("aria-disabled")).toBe("true");
  expect(remote.home.textContent).toBe("Jelly home unavailable here");
  for (const origin of [
    "https://evil.example",
    "http://127.0.0.1:5173/apps",
    "http://127.0.0.1:5173/?return=https://evil.example",
    "http://user:secret@fixture.ts.net:5173",
  ])
    expect(() => bridgeFixture(false, false, [origin])).toThrow();
});
test("template keeps direct home visible unless exact origin, parent source, app identity and schema handshake validate", () => {
  const f = bridgeFixture();
  expect(f.home.hidden).toBe(false);
  expect(f.home.href).toBe("http://127.0.0.1:5173/apps");
  const valid = {
    origin: "http://127.0.0.1:5173",
    source: f.parent,
    data: { type: "jelly:viewer", appId: app.id },
  };
  for (const invalid of [
    { ...valid, origin: "https://evil.example" },
    { ...valid, source: {} },
    { ...valid, data: { type: "jelly:viewer", appId: "other-app" } },
    { ...valid, data: { ...valid.data, returnUrl: "https://evil.example" } },
    { ...valid, data: { type: "jelly:ready", appId: app.id } },
  ]) {
    f.message(invalid);
    expect(f.home.hidden).toBe(false);
  }
  expect(f.bridge.reportRoute("/notes")).toBe(false);
  f.message(valid);
  expect(f.home.hidden).toBe(true);
  expect(f.sent).toHaveBeenLastCalledWith(
    { type: "jelly:ready", appId: app.id },
    valid.origin,
  );
  expect(f.bridge.reportRoute("/notes")).toBe(true);
  expect(f.sent).toHaveBeenLastCalledWith(
    { type: "jelly:route", appId: app.id, route: "/notes" },
    valid.origin,
  );
  for (const route of [
    "//evil.example",
    "/?token=secret",
    "/%2e%2e",
    "/../secret",
    "/a\\b",
  ])
    expect(f.bridge.reportRoute(route)).toBe(false);
  f.bridge.close();
  expect(f.home.hidden).toBe(false);
  expect(f.bridge.reportRoute("/notes")).toBe(false);
  expect(bridgeFixture(true).home.href).toBe("http://fixture.ts.net:5173/apps");
});
