import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  APPS_INSTRUCTIONS,
  appsTools,
  instanceInfoTool,
  type AppsToolsService,
} from "../src/server/apps-tools";
import { appsCapabilities } from "../src/shared/apps";
import { Harness } from "../src/server/harness";
import { Store } from "../src/server/store";
import { SessionWork } from "../src/server/session-work";
import { fixtureModel, fixtureStream } from "./fixtures/model";
const capabilities = appsCapabilities();
const app = {
  id: "fixture-app",
  name: "Fixture",
  url: "http://localhost:3007",
};
const identity = { id: "builder", name: "Builder", projectId: null };
function fixture() {
  const service = {
    list: mock(() => ({
      starred: [],
      history: [app],
      after: null,
      capabilities,
    })),
    get: mock(() => app),
    register: mock(() => app),
    setStarred: mock(() => app),
    capabilities: mock(async () => capabilities),
    remove: mock(() => ({ ok: true })),
  };
  const tools = appsTools(service as unknown as AppsToolsService, identity);
  return { service, tools };
}
function data(result: any) {
  return JSON.parse(result.content[0].text);
}
test("Apps tools expose only trusted registry operations with closed schemas", async () => {
  const f = fixture();
  expect(f.tools.map((tool) => tool.name)).toEqual([
    "apps_list",
    "apps_get",
    "apps_register",
    "apps_set_starred",
    "apps_remove",
  ]);
  for (const tool of f.tools)
    expect((tool.parameters as any).additionalProperties).toBe(false);
  const registration = f.tools.find((tool) => tool.name === "apps_register")!;
  expect((registration.parameters as any).properties).toHaveProperty("url");
  expect((registration.parameters as any).properties).not.toHaveProperty(
    "launchMode",
  );
  await registration.execute(
    "test",
    { name: "Fixture", url: app.url },
    new AbortController().signal,
    undefined,
    {} as any,
  );
  expect(f.service.register).toHaveBeenCalledWith(
    { name: "Fixture", url: app.url },
    { builderAgentId: "builder", projectId: null },
  );
  const get = data(
    await f.tools
      .find((tool) => tool.name === "apps_get")!
      .execute(
        "test",
        { id: app.id },
        new AbortController().signal,
        undefined,
        {} as any,
      ),
  );
  expect(get.viewerUrl).toBe("/apps/fixture-app");
  await f.tools
    .find((tool) => tool.name === "apps_remove")!
    .execute(
      "test",
      { id: app.id },
      new AbortController().signal,
      undefined,
      {} as any,
    );
  expect(f.service.remove).toHaveBeenCalledWith(app.id);
  expect((f.tools.at(-1)!.parameters as any).properties).not.toHaveProperty(
    "uninstall",
  );
  const abort = new AbortController();
  abort.abort();
  await expect(
    registration.execute("test", {}, abort.signal, undefined, {} as any),
  ).rejects.toThrow();
  expect(f.service.register).toHaveBeenCalledTimes(1);
  const info = data(
    await instanceInfoTool(
      { id: "instance", name: "Test" },
      identity,
      f.service,
    ).execute("test", {}, new AbortController().signal, undefined, {} as any),
  );
  expect(info.apps).toEqual({ homeUrl: "/apps", capabilities });
  expect(APPS_INSTRUCTIONS).toContain("same-host ports");
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
  expect(session.getActiveToolNames()).not.toContain("apps_deploy");
}, 15000);
