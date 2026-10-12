import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/server/store";
import { AppsService } from "../src/server/apps-service";
import {
  appUnit,
  unitName,
  defaultAppsCapabilities,
  type AppsAdapter,
} from "../src/server/apps-runtime";
import { linkedOrigin, validateManifest } from "../src/server/apps-validation";
import type {
  AppManifest,
  AppsCapabilities,
  AppObservation,
  AppGatewayIdentity,
} from "../src/shared/apps";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export class FakeAppsAdapter implements AppsAdapter {
  cap: AppsCapabilities = {
    ...defaultAppsCapabilities("linux"),
    supported: true,
    systemd: true,
    lingering: true,
    managedDeployment: true,
    gatewayNode: true,
    gatewayNodeVersion: "22.22.1",
    tailscale: true,
    tailnetAddresses: ["100.64.0.2"],
    tailnetHostname: "fixture.tailfixture.ts.net",
    warnings: [],
  };
  units = new Map<string, string>();
  actions: [string, string[]][] = [];
  states = new Map<string, AppObservation["serviceState"]>();
  commands: {
    executable: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  busyPorts = new Set<number>();
  healthy = true;
  gatewayIdentity?: AppGatewayIdentity;
  isolated = true;
  commandCode = 0;
  output = "";
  failActivation = false;
  gate?: () => Promise<void>;
  async capabilities() {
    return this.cap;
  }
  async gatewayExecutable() {
    return "/usr/bin/node";
  }
  async portAvailable(port: number) {
    return !this.busyPorts.has(port);
  }
  async command(
    executable: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) {
    this.commands.push({ executable, args, ...options });
    await this.gate?.();
    return { code: this.commandCode, stdout: this.output, stderr: "" };
  }
  async readUnit(name: string) {
    return this.units.get(name) ?? null;
  }
  async installUnit(name: string, content: string) {
    const old = this.units.get(name);
    if (old && old.split("\n")[0] !== content.split("\n")[0])
      throw new Error("Foreign unit");
    this.units.set(name, content);
  }
  async removeUnit(name: string) {
    this.units.delete(name);
  }
  async systemctl(
    action: Parameters<AppsAdapter["systemctl"]>[0],
    units: string[] = [],
  ) {
    this.actions.push([action, units]);
    if (action === "restart" && this.failActivation) {
      this.failActivation = false;
      throw new Error("Activation failed");
    }
    if (["start", "restart", "stop"].includes(action))
      for (const unit of units)
        this.states.set(unit, action === "stop" ? "stopped" : "running");
  }
  async state(name: string) {
    return this.states.get(name) ?? "stopped";
  }
  async health(
    _origin?: string,
    _path?: string,
    identity?: AppGatewayIdentity,
  ) {
    return (
      this.healthy &&
      (!identity ||
        !this.gatewayIdentity ||
        (identity.instanceId === this.gatewayIdentity.instanceId &&
          identity.appId === this.gatewayIdentity.appId &&
          identity.deploymentRevision ===
            this.gatewayIdentity.deploymentRevision))
    );
  }
  async socketHealth() {
    return this.healthy;
  }
  async runtimeIsolation() {
    return { safe: this.isolated, ready: true };
  }
  async logs() {
    return this.output;
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-apps-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "temporary.sqlite"));
  cleanups.push(() => store.close());
  const adapter = new FakeAppsAdapter();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const service = new AppsService(store, {
    dataDir: dir,
    socketBaseDir: join(dir, "s"),
    allowedOrigins: ["http://jelly.tailfixture.ts.net:5173"],
    adapter,
    emit: (type, data) => events.push({ type, data }),
    healthAttempts: 1,
    healthDelayMs: 0,
    observationIntervalMs: 0,
  });
  cleanups.push(() => service.close());
  const source = join(dir, "project");
  mkdirSync(source);
  writeFileSync(join(source, "index.txt"), "first source");
  const manifest: AppManifest = {
    name: "Example",
    sourceDirectory: source,
    executable: process.execPath,
    args: ["serve.ts", "{socket}", "{dataDir}", "literal;$(no-shell)"],
    build: { executable: process.execPath, args: ["run", "build"] },
    test: { executable: process.execPath, args: ["test"] },
    migrationPlan: "No schema changes; storage is backward compatible.",
    healthPath: "/health",
  };
  return { dir, store, adapter, events, service, source, manifest };
}
describe("Apps registry", () => {
  test("migration v15 reopens, stars/visits persist; no agent or project cascade", async () => {
    const f = fixture();
    expect(f.store.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 15,
    });
    const project = f.store.saveProject(
      "project",
      "Project",
      "project",
      f.source,
    );
    const agent = f.store.addAgent({
      name: "Builder",
      instructions: "",
      color: "#123456",
      projectId: project.id,
    });
    let app = f.service.register({
      name: "New app",
      projectId: project.id,
      builderAgentId: agent.id,
    });
    f.store.archiveAgent(agent.id, true);
    f.store.deleteProject(project.id);
    expect(f.service.get(app.id).builderAgentId).toBe(agent.id);
    expect(app.starredAt).toBeNull();
    expect(app.lastOpenedAt).toBeNull();
    app = f.service.setStarred(app.id, true);
    const starredAt = app.starredAt;
    expect(f.service.setStarred(app.id, true).starredAt).toBe(starredAt);
    const launched = f.service.recordLaunch(app.id, "one-navigation");
    expect(f.service.recordLaunch(app.id, "one-navigation").lastOpenedAt).toBe(
      launched.lastOpenedAt,
    );
    expect(launched.starredAt).toBe(starredAt);
    const rename = f.service.register({ id: app.id, name: "Renamed" });
    expect(rename.slug).toBe(app.slug);
    expect(rename.lastOpenedAt).toBe(launched.lastOpenedAt);
    expect(rename.starredAt).toBe(starredAt);
    f.service.setStarred(app.id, false);
    const restarred = f.service.setStarred(app.id, true);
    expect(restarred.starredAt! > starredAt!).toBe(true);
    const reopened = new Store(join(f.dir, "temporary.sqlite"));
    try {
      const service = new AppsService(reopened, {
        dataDir: f.dir,
        adapter: f.adapter,
        observationIntervalMs: 0,
      });
      expect(service.get(app.id)).toEqual(restarred);
      expect(service.recordLaunch(app.id, "one-navigation").lastOpenedAt).toBe(
        launched.lastOpenedAt,
      );
      await service.close();
    } finally {
      reopened.close();
    }
    expect(f.events.map((e) => e.type)).toContain("apps_changed");
  });
  test("idempotent slug registration, stable starred/history grouping, search and validated cursors", () => {
    const { service } = fixture();
    const a = service.register({ id: "a", name: "Alpha" });
    const b = service.register({ id: "b", name: "Beta" });
    const c = service.register({
      id: "c",
      name: "Charlie",
      description: "alpha category",
    });
    expect(service.register({ name: "Beta", description: "Updated" }).id).toBe(
      b.id,
    );
    service.setStarred(a.id, true);
    service.setStarred(b.id, true);
    service.recordLaunch(a.id, "launch-a");
    expect(service.list().starred.map((a) => a.id)).toEqual([b.id, a.id]);
    expect(service.list().history.map((a) => a.id)).toEqual([c.id]);
    service.setStarred(a.id, false);
    expect(service.list().history[0]!.id).toBe(a.id);
    const page = service.list({ limit: 1 });
    expect(page.after).not.toBeNull();
    expect(service.list({ limit: 1, after: page.after! }).history[0]!.id).toBe(
      c.id,
    );
    expect(service.list({ q: "alpha" }).history.map((a) => a.id)).toEqual([
      a.id,
      c.id,
    ]);
    expect(() => service.list({ q: "other", after: page.after! })).toThrow(
      "cursor",
    );
    expect(() => service.list({ after: "garbage" })).toThrow("cursor");
    expect(() => service.list({ limit: 0 })).toThrow("Limit");
    expect(() =>
      service.register({ id: c.id, name: "Conflict", slug: b.slug }),
    ).toThrow("slug");
    expect(() =>
      service.register({ name: "Injected", runtimePort: 40000 }),
    ).toThrow("server-controlled");
  });
  test("tie ordering uses ID; distinct private linked origins never get probed or controls", async () => {
    const { service, store, adapter } = fixture();
    const a = service.register({
      id: "a",
      name: "Local",
      managementMode: "linked",
      url: "http://127.0.0.2:9000",
    });
    expect(a.tailnetOrigin).toBeNull();
    expect(a.launchMode).toBe("direct");
    expect(a.observation.checkedAt).toBeNull();
    const b = service.register({
      id: "b",
      name: "Tailnet",
      url: "https://app.tailfixture.ts.net",
    });
    expect(b.tailnetOrigin).toBe("https://app.tailfixture.ts.net");
    const tied = { ...b, createdAt: a.createdAt };
    store.db
      .query("UPDATE apps SET record=? WHERE id=?")
      .run(JSON.stringify(tied), b.id);
    expect(service.list().history.map((a) => a.id)).toEqual(["a", "b"]);
    await expect(service.control(a.id, "stop")).rejects.toThrow("managed");
    await expect(service.remove(b.id, { uninstall: true })).rejects.toThrow(
      "linked",
    );
    expect(adapter.actions).toEqual([]);
    await service.remove(a.id, { uninstall: false });
    expect(() => service.get(a.id)).toThrow("not found");
  });
});
describe("Private linked URL validation", () => {
  test.each([
    "http://127.0.0.1:9000",
    "http://localhost:9000",
    "http://jelly.tailfixture.ts.net:9000",
    "https://sub.jelly.tailfixture.ts.net",
    "https://tailfixture.ts.net",
    "http://example.com",
    "http://192.168.1.2",
    "http://100.63.0.1",
    "http://100.128.0.1",
    "http://0.0.0.0",
    "http://app.tailfixture.ts.net.evil.com",
    "http://user:password@app.tailfixture.ts.net",
    "http://app.tailfixture.ts.net/path",
    "http://app.tailfixture.ts.net/?token=secret",
    "http://app.tailfixture.ts.net/#secret",
    "file:///etc/passwd",
  ])("rejects unsafe URL %s", (url) => {
    expect(() =>
      linkedOrigin(url, ["http://jelly.tailfixture.ts.net:5173"]),
    ).toThrow();
  });
  test("accepts private IPv4/IPv6 and exact independent tailnet DNS", () => {
    expect(linkedOrigin("http://100.64.0.2:1234", []).tailnetOrigin).toBe(
      "http://100.64.0.2:1234",
    );
    expect(
      linkedOrigin("http://[fd7a:115c:a1e0::1]:1234", []).tailnetOrigin,
    ).toContain("fd7a");
    expect(
      linkedOrigin("http://app.tailfixture.ts.net", []).tailnetOrigin,
    ).not.toBeNull();
  });
});
describe("Managed Apps deployment", () => {
  test("build/test before activation, persistent scripts, secret references only, checked health and no auto-star", async () => {
    const f = fixture();
    const secret = join(f.dir, "secrets.env");
    writeFileSync(secret, "API_TOKEN=never-return-this\nHOST=0.0.0.0", {
      mode: 0o600,
    });
    const app = await f.service.deploy({
      ...f.manifest,
      environmentFiles: [secret],
    });
    expect(f.adapter.commands.length).toBe(2);
    expect(f.adapter.commands.map((c) => c.args)).toEqual([
      ["run", "build"],
      ["test"],
    ]);
    expect(f.adapter.commands[0]!.env.HOST).toBe("127.0.0.1");
    expect(f.adapter.commands[0]!.cwd).toContain("/releases/");
    expect(app.desiredState).toBe("ready");
    expect(app.observation.httpHealthy).toBe(true);
    expect(app.observation.checkedAt).not.toBeNull();
    expect(app.observation.tailnetReachable).toBeNull();
    expect(app.starredAt).toBeNull();
    expect(app.lastOpenedAt).toBeNull();
    expect(app.localOrigin).toBe(`http://127.0.0.1:${app.gatewayPort}`);
    expect(app.localOrigin).not.toContain(String(app.runtimeSocket));
    const runtime = f.adapter.units.get(app.unitName!)!;
    const gateway = f.adapter.units.get(
      unitName(f.store.instance().id, app.id, true),
    )!;
    expect(runtime).toContain("EnvironmentFile=");
    expect(runtime).not.toContain("never-return-this");
    expect(gateway).toContain("/apps/runtime/");
    expect(gateway).not.toContain("worktrees");
    const persisted = JSON.stringify(f.service.get(app.id));
    expect(persisted).not.toContain("never-return-this");
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("cookieKey");
    const release = f.store.db
      .query("SELECT configuration FROM app_releases WHERE appId=?")
      .get(app.id) as { configuration: string };
    const directory = JSON.parse(release.configuration).directory;
    const config = JSON.parse(
      readFileSync(join(directory, "launcher.json"), "utf8"),
    );
    expect(config.args).toEqual([
      "serve.ts",
      String(app.runtimeSocket),
      join(f.dir, "apps/data", app.id),
      "literal;$(no-shell)",
    ]);
    const launcherPath = runtime.match(/"([^\"]+app-launcher.ts)"/)![1]!;
    expect(readFileSync(launcherPath, "utf8")).toContain("HOST:'127.0.0.1'");
    await f.service.close();
    expect(f.adapter.actions.at(-1)![0]).toBe("restart");
  });
  test("persistent launcher injects Jelly identity/origins/corner after environment-file overrides", async () => {
    const f = fixture();
    const app = await f.service.deploy({
      ...f.manifest,
      viewerCorner: "bottom-right",
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({id:process.env.JELLY_APP_ID,origins:process.env.JELLY_ALLOWED_ORIGINS,corner:process.env.JELLY_VIEWER_CORNER,host:process.env.HOST,port:process.env.PORT,socket:process.env.APP_SOCKET,data:process.env.APP_DATA_DIR}))",
      ],
    });
    const release = f.store.db
      .query(
        "SELECT configuration FROM app_releases WHERE appId=? AND revision=?",
      )
      .get(app.id, app.deploymentRevision!) as { configuration: string };
    const directory = JSON.parse(release.configuration).directory;
    const launcherPath = f.adapter.units
      .get(app.unitName!)!
      .match(/"([^\"]+app-launcher.ts)"/)![1]!;
    const child = Bun.spawn(
      [process.execPath, launcherPath, join(directory, "launcher.json")],
      {
        env: {
          ...process.env,
          HOST: "0.0.0.0",
          PORT: "9999",
          APP_DATA_DIR: "/wrong",
          APP_SOCKET: "/wrong.sock",
          JELLY_APP_ID: "wrong",
          JELLY_ALLOWED_ORIGINS: "wrong",
          JELLY_VIEWER_CORNER: "wrong",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).json();
    expect(await child.exited).toBe(0);
    expect(output).toEqual({
      id: app.id,
      origins: JSON.stringify(app.allowedJellyOrigins),
      corner: "bottom-right",
      host: "127.0.0.1",
      port: "0",
      socket: app.runtimeSocket,
      data: join(f.dir, "apps/data", app.id),
    });
    expect(f.adapter.commands[0]!.env.JELLY_APP_ID).toBe(app.id);
    expect(f.adapter.commands[0]!.env.JELLY_ALLOWED_ORIGINS).toBe(
      JSON.stringify(app.allowedJellyOrigins),
    );
    expect(f.adapter.commands[0]!.env.JELLY_VIEWER_CORNER).toBe("bottom-right");
  });
  test("failed build never activates, releases ports, keeps useful redacted diagnostics", async () => {
    const f = fixture();
    f.adapter.commandCode = 1;
    f.adapter.output =
      'token=top-secret password=private-value {"api_key":"json-private-value"}';
    await expect(f.service.deploy(f.manifest)).rejects.toThrow("Build failed");
    const app = f.service.list().history[0]!;
    expect(app.desiredState).toBe("draft");
    expect(app.observation.httpHealthy).toBe(false);
    expect(app.runtimeSocket).toBeNull();
    expect(f.adapter.actions).toEqual([]);
    expect(f.store.db.query("SELECT * FROM app_ports").all()).toEqual([]);
    const logs = await f.service.logs(app.id);
    expect(logs.text).toContain("[redacted]");
    expect(logs.text).not.toContain("top-secret");
    expect(logs.text).not.toContain("private-value");
    expect(logs.text).not.toContain("json-private-value");
  });
  test("failed redeploy restores last-good release, metadata preferences and persistent data", async () => {
    const f = fixture();
    const first = await f.service.deploy(f.manifest);
    f.service.setStarred(first.id, true);
    f.service.recordLaunch(first.id, "visit");
    const preferred = f.service.get(first.id);
    f.adapter.failActivation = true;
    await expect(
      f.service.deploy({ ...f.manifest, id: first.id }),
    ).rejects.toThrow("deployment failed");
    const after = f.service.get(first.id);
    expect(after.deploymentRevision).toBe(first.deploymentRevision);
    expect(after.starredAt).toBe(preferred.starredAt);
    expect(after.lastOpenedAt).toBe(preferred.lastOpenedAt);
    expect(after.desiredState).toBe("ready");
    expect(after.observation.httpHealthy).toBe(true);
    expect(after.observation.lastError).toContain("failed");
    expect(f.adapter.units.get(first.unitName!)).toContain(
      first.deploymentRevision!,
    );
    expect(
      f.store.db
        .query("SELECT * FROM app_releases WHERE appId=?")
        .all(first.id),
    ).toHaveLength(2);
    await expect(
      f.service.deploy({
        ...f.manifest,
        id: first.id,
        migrationPlan: undefined,
      }),
    ).rejects.toThrow("migration");
    expect(f.service.get(first.id).deploymentRevision).toBe(
      first.deploymentRevision,
    );
  });
  test("concurrent deploys allocate disjoint ports; per-app locks block competing lifecycle but preserve stars/visits", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.adapter.gate = async () => {
      entered();
      await waiting;
    };
    const deploying = f.service.deploy(f.manifest);
    await started;
    const draft = f.service.list().history[0]!;
    await expect(
      f.service.deploy({ ...f.manifest, id: draft.id }),
    ).rejects.toThrow("progress");
    await expect(
      f.service.remove(draft.id, { uninstall: false }),
    ).rejects.toThrow("progress");
    f.service.setStarred(draft.id, true);
    f.service.recordLaunch(draft.id, "during-build");
    const other = f.service.deploy({ ...f.manifest, name: "Other" });
    release();
    const [a, b] = await Promise.all([deploying, other]);
    expect(
      new Set([a.runtimeSocket, a.gatewayPort, b.runtimeSocket, b.gatewayPort])
        .size,
    ).toBe(4);
    expect(a.starredAt).not.toBeNull();
    expect(a.lastOpenedAt).not.toBeNull();
    expect(f.store.db.query("SELECT * FROM app_locks").all()).toEqual([]);
  });
  test("OS gateway listener conflicts and TCP runtimes are rejected", async () => {
    const f = fixture();
    f.adapter.busyPorts.add(32000);
    const first = await f.service.deploy(f.manifest);
    expect(first.gatewayPort).toBe(32001);
    f.adapter.isolated = false;
    await expect(
      f.service.deploy({ ...f.manifest, name: "Wildcard" }),
    ).rejects.toThrow("Unsafe runtime isolation");
    expect(
      f.service.list().history.find((a) => a.name === "Wildcard")!.desiredState,
    ).toBe("draft");
  });
  test("unregister retains service/reservations, uninstall stops only owned units and retains data", async () => {
    const f = fixture();
    const first = await f.service.deploy(f.manifest);
    const second = await f.service.deploy({ ...f.manifest, name: "Other" });
    f.adapter.actions = [];
    expect(await f.service.remove(first.id, { uninstall: false })).toEqual({
      removed: true,
      serviceRetained: true,
      dataRetained: true,
    });
    expect(f.adapter.actions).toEqual([]);
    expect(
      f.store.db
        .query("SELECT * FROM app_resources WHERE appId=?")
        .get(first.id),
    ).not.toBeNull();
    expect(() => f.service.register({ id: first.id, name: "Revive" })).toThrow(
      "unregistered",
    );
    await f.service.control(second.id, "stop");
    expect(f.service.get(second.id).desiredState).toBe("stopped");
    await f.service.control(second.id, "start");
    expect(f.service.get(second.id).observation.httpHealthy).toBe(true);
    await f.service.remove(second.id, { uninstall: true });
    expect(f.adapter.units.has(second.unitName!)).toBe(false);
    expect(f.adapter.units.has(first.unitName!)).toBe(true);
    expect(
      f.adapter.actions
        .flatMap((a) => a[1])
        .every(
          (name) =>
            name === second.unitName ||
            name === unitName(f.store.instance().id, second.id, true),
        ),
    ).toBe(true);
    expect(
      f.store.db.query("SELECT * FROM app_ports WHERE appId=?").all(second.id),
    ).toEqual([]);
    expect(
      readFileSync(
        join(f.dir, "apps/data", second.id, "gateway-cookie-key"),
        "utf8",
      ),
    ).toHaveLength(64);
  });
  test("foreign unit conflicts are rejected before lifecycle calls; interrupted leases recover registry only", async () => {
    const f = fixture();
    const draft = f.service.register({ id: "foreign", name: "Foreign" });
    f.adapter.units.set(
      unitName(f.store.instance().id, draft.id, true),
      "# Not Jelly-owned\n",
    );
    await expect(
      f.service.deploy({ ...f.manifest, id: draft.id }),
    ).rejects.toThrow("ownership");
    expect(f.adapter.actions).toEqual([]);
    expect(
      f.adapter.units.get(unitName(f.store.instance().id, draft.id, true)),
    ).toBe("# Not Jelly-owned\n");
    const good = await f.service.deploy({ ...f.manifest, name: "Good" });
    const originalUnit = f.adapter.units.get(good.unitName!)!;
    f.adapter.units.set(good.unitName!, "# Foreign replacement\n");
    f.adapter.actions = [];
    await expect(f.service.control(good.id, "stop")).rejects.toThrow(
      "ownership",
    );
    await expect(
      f.service.remove(good.id, { uninstall: true }),
    ).rejects.toThrow("ownership");
    expect(f.adapter.actions).toEqual([]);
    f.adapter.units.set(good.unitName!, originalUnit);
    f.store.db
      .query("UPDATE apps SET record=? WHERE id=?")
      .run(JSON.stringify({ ...good, desiredState: "deploying" }), good.id);
    f.store.db
      .query("INSERT INTO app_locks(appId,owner,expiresAt) VALUES (?,?,?)")
      .run(good.id, "999999999-dead", Date.now() + 100000);
    const recovered = new AppsService(f.store, {
      dataDir: f.dir,
      adapter: f.adapter,
      observationIntervalMs: 0,
    });
    expect(recovered.get(good.id).desiredState).toBe("ready");
    expect(recovered.get(good.id).deploymentRevision).toBe(
      good.deploymentRevision,
    );
    expect(recovered.get(good.id).observation.lastError).toContain(
      "interrupted",
    );
    expect(f.adapter.actions).toEqual([]);
    await recovered.close();
    f.adapter.units.set(
      good.unitName!,
      originalUnit.replace(good.deploymentRevision!, "unconfirmed-revision"),
    );
    await f.service.control(good.id, "start");
    expect(f.adapter.units.get(good.unitName!)).toContain(
      good.deploymentRevision!,
    );
    expect(f.adapter.actions.at(-1)![0]).toBe("restart");
  });
  test("private HTTPS Jelly forces direct launch and explicit secret-file permissions are validated", async () => {
    const f = fixture();
    f.service.configureOrigins(["https://jelly.tailfixture.ts.net"]);
    const app = await f.service.deploy(f.manifest);
    expect(app.launchMode).toBe("direct");
    expect(app.allowedJellyOrigins).toEqual([
      "https://jelly.tailfixture.ts.net",
    ]);
    const publicSecret = join(f.dir, "public.env");
    writeFileSync(publicSecret, "TOKEN=private", { mode: 0o644 });
    expect(() =>
      validateManifest({ ...f.manifest, environmentFiles: [publicSecret] }),
    ).toThrow("private");
    const embeddedSecret = join(f.source, "secret.env");
    writeFileSync(embeddedSecret, "TOKEN=private", { mode: 0o600 });
    expect(() =>
      validateManifest({ ...f.manifest, environmentFiles: [embeddedSecret] }),
    ).toThrow("outside");
    await expect(
      f.service.deploy({
        ...f.manifest,
        name: "Ephemeral",
        args: ["/home/test/worktrees/app/start.js"],
      }),
    ).rejects.toThrow("ephemeral");
  });
  test("unsupported platforms and missing lingering report actionable failures without activation", async () => {
    const f = fixture();
    f.adapter.cap = defaultAppsCapabilities("darwin");
    await expect(f.service.deploy(f.manifest)).rejects.toThrow("unsupported");
    expect(f.service.list().history).toEqual([]);
    f.adapter.cap = {
      ...defaultAppsCapabilities("linux"),
      supported: true,
      warnings: ["Enable user lingering before deployment."],
    };
    await expect(f.service.deploy(f.manifest)).rejects.toThrow("lingering");
    expect(f.adapter.actions).toEqual([]);
  });
  test("secrets and outside symlinks cannot enter release snapshots; units escape systemd expansions", async () => {
    const f = fixture();
    writeFileSync(join(f.source, ".env"), "PRIVATE=should-not-copy");
    const app = await f.service.deploy(f.manifest);
    const row = f.store.db
      .query(
        "SELECT configuration FROM app_releases WHERE appId=? AND revision=?",
      )
      .get(app.id, app.deploymentRevision!) as { configuration: string };
    expect(() =>
      readFileSync(
        join(JSON.parse(row.configuration).directory, "source/.env"),
      ),
    ).toThrow();
    const secret = join(f.dir, "outside-secret");
    writeFileSync(secret, "private");
    symlinkSync(secret, join(f.source, "linked-secret"));
    await expect(
      f.service.deploy({ ...f.manifest, name: "Unsafe symlink" }),
    ).rejects.toThrow("symlinks");
    expect(() =>
      validateManifest({ ...f.manifest, executable: "bun" }),
    ).toThrow("absolute");
    expect(() =>
      validateManifest({ ...f.manifest, args: ["--token", "inline-secret"] }),
    ).toThrow("Secrets");
    expect(() =>
      validateManifest({
        ...f.manifest,
        healthPath: "//public.example.com/private",
      }),
    ).toThrow("Health path");
    expect(() =>
      validateManifest({ ...f.manifest, healthPath: "/health?token=secret" }),
    ).toThrow("Health path");
    const unit = appUnit(
      "instance",
      "test",
      ["/usr/bin/bun", 'a %n $HOME \\" ; $(command)'],
      "/tmp/safe",
    );
    expect(unit).toContain("%%n");
    expect(unit).toContain("$$HOME");
    expect(unit).toContain("Restart=on-failure");
    expect(unitName("instance", "x-gateway")).not.toBe(
      unitName("instance", "x", true),
    );
  });
});

test("canonical snapshot exclusions cannot be bypassed by file or directory aliases", async () => {
  const f = fixture();
  const outside = join(f.dir, "outside-sentinel");
  writeFileSync(outside, "outside source must never enter a release");
  for (const name of [".git", ".env.cache"]) {
    mkdirSync(join(f.source, name));
    writeFileSync(join(f.source, name, "private.txt"), "excluded metadata");
    symlinkSync(outside, join(f.source, name, "outside-link.txt"));
    symlinkSync(
      name,
      join(f.source, `${name === ".git" ? "git" : "env"}-alias`),
    );
  }
  writeFileSync(join(f.source, ".env.production"), "PRIVATE=excluded");
  symlinkSync(".env.production", join(f.source, "innocent-file"));
  mkdirSync(join(f.source, "assets"));
  writeFileSync(join(f.source, "assets", "public.txt"), "safe asset");
  symlinkSync("../.git", join(f.source, "assets", "nested-alias"));
  symlinkSync("assets", join(f.source, "public-assets"));
  symlinkSync("index.txt", join(f.source, "safe-file"));

  const app = await f.service.deploy(f.manifest);
  const row = f.store.db
    .query(
      "SELECT configuration FROM app_releases WHERE appId=? AND revision=?",
    )
    .get(app.id, app.deploymentRevision!) as { configuration: string };
  const copied = join(JSON.parse(row.configuration).directory, "source");
  for (const name of [
    ".git",
    ".env.cache",
    ".env.production",
    "git-alias",
    "env-alias",
    "innocent-file",
    "assets/nested-alias",
    "public-assets/nested-alias",
  ])
    expect(existsSync(join(copied, name))).toBe(false);
  expect(
    readFileSync(join(copied, "public-assets", "public.txt"), "utf8"),
  ).toBe("safe asset");
  expect(readFileSync(join(copied, "safe-file"), "utf8")).toBe("first source");
});

test("snapshot inspection traverses valid directory aliases and rejects external nested targets", async () => {
  const f = fixture();
  mkdirSync(join(f.source, "assets"));
  const outside = join(f.dir, "outside-sentinel");
  writeFileSync(outside, "synthetic outside content");
  symlinkSync(outside, join(f.source, "assets", "outside-link"));
  symlinkSync("assets", join(f.source, "public-assets"));
  await expect(f.service.deploy(f.manifest)).rejects.toThrow("symlinks");
  expect(f.adapter.commands).toEqual([]);
  expect(f.adapter.units.size).toBe(0);
});

test("directory alias cycles fail before copying or running build/test commands", async () => {
  const f = fixture();
  mkdirSync(join(f.source, "assets"));
  symlinkSync("..", join(f.source, "assets", "back-to-source"));
  await expect(f.service.deploy(f.manifest)).rejects.toThrow("cycles");
  expect(f.adapter.commands).toEqual([]);
  expect(f.adapter.units.size).toBe(0);
});

test("register insertion defaults are transactional; ID/slug edits preserve ownership, stars and history", async () => {
  const f = fixture();
  const project = f.store.saveProject("apps-project", "Apps", "apps", f.source);
  const firstBuilder = f.store.addAgent({
    name: "First",
    color: "#abcdef",
    instructions: "",
  });
  const laterBuilder = f.store.addAgent({
    name: "Later",
    color: "#abcdef",
    instructions: "",
  });
  const defaults = { builderAgentId: firstBuilder.id, projectId: project.id };
  const created = f.service.register(
    { name: "With defaults", slug: "with-defaults" },
    defaults,
  );
  expect(created.builderAgentId).toBe(firstBuilder.id);
  expect(created.projectId).toBe(project.id);
  const favorite = f.service.setStarred(created.id, true);
  const visited = f.service.recordLaunch(created.id, "default-visit");
  const updated = f.service.register(
    { id: created.id, description: "Partial metadata" },
    { builderAgentId: laterBuilder.id, projectId: null },
  );
  expect(updated.name).toBe(created.name);
  expect(updated.builderAgentId).toBe(firstBuilder.id);
  expect(updated.projectId).toBe(project.id);
  expect(updated.starredAt).toBe(favorite.starredAt);
  expect(updated.lastOpenedAt).toBe(visited.lastOpenedAt);
  const bySlug = f.service.register(
    { name: "Renamed", slug: created.slug },
    { builderAgentId: laterBuilder.id, projectId: null },
  );
  expect(bySlug.id).toBe(created.id);
  expect(bySlug.builderAgentId).toBe(firstBuilder.id);
  const explicit = f.service.register(
    { name: "Explicit", projectId: null, builderAgentId: laterBuilder.id },
    defaults,
  );
  expect(explicit.projectId).toBeNull();
  expect(explicit.builderAgentId).toBe(laterBuilder.id);
  expect(() =>
    f.service.register(
      { name: "Invalid insertion", slug: "invalid-default" },
      { ...defaults, projectId: "missing" },
    ),
  ).toThrow("not found");
  expect(
    f.service.list().history.some((app) => app.slug === "invalid-default"),
  ).toBe(false);
  const deployed = await f.service.deploy(
    { ...f.manifest, slug: "deployed-default", viewerCorner: "bottom-right" },
    defaults,
  );
  expect(deployed.builderAgentId).toBe(firstBuilder.id);
  expect(deployed.projectId).toBe(project.id);
  const redeployed = await f.service.deploy(
    { ...f.manifest, id: deployed.id },
    { builderAgentId: laterBuilder.id, projectId: null },
  );
  expect(redeployed.viewerCorner).toBe("bottom-right");
  expect(redeployed.builderAgentId).toBe(firstBuilder.id);
  expect(redeployed.projectId).toBe(project.id);
  expect(redeployed.starredAt).toBeNull();
  expect(redeployed.lastOpenedAt).toBeNull();
});

test("build/test env and dataDir substitutions use cleaned disposable storage, never durable runtime data", async () => {
  const f = fixture();
  const paths: string[] = [];
  f.adapter.gate = async () => {
    const command = f.adapter.commands.at(-1)!;
    const path = command.env.APP_DATA_DIR!;
    expect(existsSync(path)).toBe(true);
    expect(path).not.toContain(join(f.dir, "apps"));
    expect(command.args).toContain(path);
    expect(JSON.parse(command.env.JELLY_ALLOWED_ORIGINS!)).toEqual([
      "http://jelly.tailfixture.ts.net:5173",
    ]);
    writeFileSync(join(path, "test-marker"), "test-only");
    paths.push(path);
  };
  const app = await f.service.deploy({
    ...f.manifest,
    build: { executable: process.execPath, args: ["build", "{dataDir}"] },
    test: { executable: process.execPath, args: ["test", "{dataDir}"] },
  });
  expect(paths).toHaveLength(2);
  for (const path of paths) expect(existsSync(path)).toBe(false);
  const dataDir = join(f.dir, "apps", "data", app.id);
  expect(existsSync(join(dataDir, "test-marker"))).toBe(false);
  expect(app.args).toContain("{dataDir}"); // Registry manifest remains literal.
  const launcherConfig = JSON.parse(
    readFileSync(
      join(
        f.dir,
        "apps",
        "releases",
        app.id,
        app.deploymentRevision!,
        "launcher.json",
      ),
      "utf8",
    ),
  );
  expect(launcherConfig.dataDir).toBe(dataDir);
  expect(launcherConfig.args).toContain(dataDir);
  f.adapter.commandCode = 1;
  await expect(
    f.service.deploy({
      ...f.manifest,
      slug: "failed-validation",
      build: undefined,
      test: { executable: process.execPath, args: ["test", "{dataDir}"] },
    }),
  ).rejects.toThrow("Test failed");
  for (const path of paths) expect(existsSync(path)).toBe(false);
});

test("Apps close waits in-flight deployment and never stops persistent units", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.adapter.gate = async () => {
    entered();
    await gate;
  };
  const deployment = f.service.deploy(f.manifest);
  await started;
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await Bun.sleep(10);
  expect(closed).toBe(false);
  release();
  const app = await deployment;
  await closing;
  expect(closed).toBe(true);
  expect(f.service.get(app.id).observation.httpHealthy).toBe(true);
  expect(f.adapter.actions.some(([action]) => action === "stop")).toBe(false);
  expect(() => f.service.register({ name: "Closing" })).toThrow("closing");
});

test("persistent launcher exits cleanly on intentional SIGTERM and preserves unexpected child failures", async () => {
  const f = fixture();
  const app = await f.service.deploy(f.manifest);
  const runtimeUnit = f.adapter.units.get(app.unitName!)!;
  const launcherPath = runtimeUnit.match(/"([^\"]+app-launcher.ts)"/)![1]!;
  const configPath = join(f.dir, "signal-launcher.json");
  const childCode = join(f.dir, "signal-child.ts");
  writeFileSync(
    childCode,
    'console.log("child-ready"); setInterval(()=>{},1000);',
  );
  const config = {
    executable: process.execPath,
    args: [childCode],
    cwd: f.dir,
    runtimeSocket: app.runtimeSocket,
    instanceId: f.store.instance().id,
    dataDir: join(f.dir, "data"),
    appId: app.id,
    allowedOrigins: [],
    viewerCorner: "top-left",
  };
  writeFileSync(configPath, JSON.stringify(config));
  const launcherProcess = Bun.spawn(
    [process.execPath, launcherPath, configPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = launcherProcess.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await output.read()).value)).toContain(
      "child-ready",
    );
    launcherProcess.kill("SIGTERM");
    expect(await launcherProcess.exited).toBe(0);
  } finally {
    output.releaseLock();
    if (launcherProcess.exitCode === null) launcherProcess.kill("SIGKILL");
    await launcherProcess.exited;
  }
  writeFileSync(childCode, "process.exit(7);");
  const failed = Bun.spawn([process.execPath, launcherPath, configPath], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await failed.exited).toBe(7);
});

test("systemd paths and command words use field-specific escaping, not quoted WorkingDirectory or expanded environment-file names", () => {
  const text = appUnit(
    "instance",
    "escaping",
    ["/usr/bin/bun", "/tmp/a % $ path/server.ts"],
    "/tmp/a % $ path",
    ["/tmp/private % $ file.env"],
  );
  expect(text).toContain("WorkingDirectory=/tmp/a %% $ path\n");
  expect(text).toContain(
    'ExecStart="/usr/bin/bun" "/tmp/a %% $$ path/server.ts"',
  );
  expect(text).toContain('EnvironmentFile="/tmp/private %% $ file.env"');
  expect(() =>
    appUnit(
      "instance",
      "escaping",
      ["/usr/bin/bun"],
      "/tmp/path\nExecStart=/bin/false",
    ),
  ).toThrow();
});

test("two independent instances sharing one adapter never replace, control or uninstall each other's units", async () => {
  const first = fixture(),
    second = fixture();
  const service = new AppsService(second.store, {
    dataDir: second.dir,
    socketBaseDir: join(second.dir, "s"),
    adapter: first.adapter,
    healthAttempts: 1,
    observationIntervalMs: 0,
  });
  cleanups.push(() => service.close());
  const a = await first.service.deploy({
    ...first.manifest,
    id: "same-app",
    launchMode: "direct",
  });
  const original = first.adapter.units.get(a.unitName!);
  first.adapter.busyPorts.add(a.gatewayPort!);
  const b = await service.deploy({ ...second.manifest, id: "same-app" });
  expect(first.store.instance().id).not.toBe(second.store.instance().id);
  expect(a.unitName).not.toBe(b.unitName);
  expect(a.runtimeSocket).not.toBe(b.runtimeSocket);
  expect(a.gatewayPort).not.toBe(b.gatewayPort);
  expect(first.adapter.units.get(a.unitName!)).toBe(original);
  expect(first.adapter.units.get(a.unitName!)).toContain(
    `instance: ${first.store.instance().id} app: same-app`,
  );
  expect(first.adapter.units.get(b.unitName!)).toContain(
    `instance: ${second.store.instance().id} app: same-app`,
  );
  first.adapter.actions = [];
  await first.service.control(a.id, "restart");
  await first.service.remove(a.id, { uninstall: true });
  expect(first.adapter.actions.flatMap(([, names]) => names)).not.toContain(
    b.unitName!,
  );
  expect(first.adapter.actions.flatMap(([, names]) => names)).not.toContain(
    unitName(second.store.instance().id, b.id, true),
  );
  expect(first.adapter.units.has(b.unitName!)).toBe(true);
  expect(await first.adapter.state(b.unitName!)).toBe("running");
  await service.control(b.id, "stop");
  expect(await first.adapter.state(b.unitName!)).toBe("stopped");
});

test("legacy ID-only ownership is never adopted or controlled", async () => {
  const f = fixture();
  const draft = f.service.register({ id: "legacy", name: "Legacy" });
  const oldName = "jelly-app-legacy.service";
  f.adapter.units.set(oldName, "# Jelly-owned app: legacy\n");
  f.store.db
    .query(
      "INSERT INTO app_resources(appId,unitName,gatewayPort,legacyRuntimePort) VALUES (?,?,?,?)",
    )
    .run(draft.id, oldName, 39001, 39000);
  await expect(
    f.service.deploy({ ...f.manifest, id: draft.id }),
  ).rejects.toThrow("never adopted");
  await expect(f.service.remove(draft.id, { uninstall: true })).rejects.toThrow(
    "ownership",
  );
  expect(f.adapter.actions).toEqual([]);
  expect(f.adapter.units.get(oldName)).toBe("# Jelly-owned app: legacy\n");
});

for (const action of ["start", "restart"] as const)
  test(`unsafe ${action} stops both owned services and retains isolation diagnostics`, async () => {
    const f = fixture();
    const app = await f.service.deploy(f.manifest);
    f.adapter.actions = [];
    f.adapter.isolated = false;
    await expect(f.service.control(app.id, action)).rejects.toThrow(
      "Unsafe runtime isolation",
    );
    expect(f.adapter.actions).toContainEqual([
      "stop",
      [app.unitName!, unitName(f.store.instance().id, app.id, true)],
    ]);
    expect(await f.adapter.state(app.unitName!)).toBe("stopped");
    expect(
      await f.adapter.state(unitName(f.store.instance().id, app.id, true)),
    ).toBe("stopped");
    expect(f.service.get(app.id).desiredState).toBe("stopped");
    expect(f.service.get(app.id).observation.lastError).toContain(
      "Both owned runtime and gateway were stopped",
    );
    expect((await f.service.logs(app.id)).text).toContain(
      "Unsafe runtime isolation",
    );
  });

test("unsafe observer quarantine differs from ordinary HTTP-health failure", async () => {
  const f = fixture();
  const app = await f.service.deploy(f.manifest);
  f.adapter.actions = [];
  f.adapter.healthy = false;
  // Drive the same observer deterministically, without a timing-sensitive timer.
  const observer = f.service as unknown as { refresh(): Promise<void> };
  await observer.refresh();
  expect(f.adapter.actions.some(([action]) => action === "stop")).toBe(false);
  expect(await f.adapter.state(app.unitName!)).toBe("running");
  expect(f.service.get(app.id).observation.lastError).toContain(
    "HTTP-unhealthy",
  );
  f.adapter.isolated = false;
  await observer.refresh();
  expect(await f.adapter.state(app.unitName!)).toBe("stopped");
  expect(
    await f.adapter.state(unitName(f.store.instance().id, app.id, true)),
  ).toBe("stopped");
  expect(f.service.get(app.id).observation.lastError).toContain(
    "Unsafe runtime isolation",
  );
});

test("deployed launch mode changes require deployment and omitted mode preserves direct gateway policy", async () => {
  const f = fixture();
  let app = await f.service.deploy({ ...f.manifest, launchMode: "direct" });
  const policy = () =>
    JSON.parse(
      readFileSync(
        join(
          f.dir,
          "apps",
          "releases",
          app.id,
          app.deploymentRevision!,
          "gateway.json",
        ),
        "utf8",
      ),
    );
  expect(policy().launchMode).toBe("direct");
  expect(() =>
    f.service.register({ id: app.id, launchMode: "embedded" }),
  ).toThrow("requires redeployment");
  expect(f.service.get(app.id).launchMode).toBe("direct");
  expect(policy().launchMode).toBe("direct");
  app = await f.service.deploy({ ...f.manifest, id: app.id });
  expect(app.launchMode).toBe("direct");
  expect(policy().launchMode).toBe("direct");
  app = await f.service.deploy({
    ...f.manifest,
    id: app.id,
    launchMode: "embedded",
  });
  expect(app.launchMode).toBe("embedded");
  expect(policy().launchMode).toBe("embedded");
});

for (const operation of ["redeploy", "restart"] as const)
  test(`paused observer quarantine serializes with healthy ${operation}, including same-revision restart`, async () => {
    const f = fixture();
    const app = await f.service.deploy(f.manifest);
    const controller = new AppsService(f.store, {
      dataDir: f.dir,
      socketBaseDir: join(f.dir, "s"),
      adapter: f.adapter,
      healthAttempts: 1,
      observationIntervalMs: 0,
    });
    cleanups.push(() => controller.close());
    f.adapter.actions = [];
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pause = true;
    f.adapter.runtimeIsolation = async () => {
      if (!pause) return { safe: true, ready: true };
      pause = false;
      entered();
      await pending;
      return { safe: false, ready: true };
    };
    const observer = f.service as unknown as { refresh(): Promise<void> };
    const observation = observer.refresh();
    try {
      await started;
      const lifecycle = () =>
        operation === "redeploy"
          ? controller.deploy({ ...f.manifest, id: app.id })
          : controller.control(app.id, "restart");
      await expect(lifecycle()).rejects.toThrow("lifecycle operation");
      expect(await f.adapter.state(app.unitName!)).toBe("running");
      expect(f.adapter.actions.some(([action]) => action === "stop")).toBe(
        false,
      );
      expect(
        f.store.db
          .query("SELECT appId FROM app_locks WHERE appId=?")
          .get(app.id),
      ).not.toBeNull();
      const starred = f.service.setStarred(app.id, true);
      const opened = f.service.recordLaunch(app.id, "during-observation");
      release();
      await observation;
      expect(await f.adapter.state(app.unitName!)).toBe("stopped");
      expect(f.service.get(app.id).desiredState).toBe("stopped");
      expect(f.service.get(app.id).starredAt).toBe(starred.starredAt);
      expect(f.service.get(app.id).lastOpenedAt).toBe(opened.lastOpenedAt);
      expect(
        f.store.db
          .query("SELECT appId FROM app_locks WHERE appId=?")
          .get(app.id),
      ).toBeNull();
      const healthy = await lifecycle();
      expect(healthy.desiredState).toBe("ready");
      expect(healthy.observation.httpHealthy).toBe(true);
      expect(await f.adapter.state(app.unitName!)).toBe("running");
      expect(
        await f.adapter.state(unitName(f.store.instance().id, app.id, true)),
      ).toBe("running");
      if (operation === "redeploy")
        expect(healthy.deploymentRevision).not.toBe(app.deploymentRevision);
      else expect(healthy.deploymentRevision).toBe(app.deploymentRevision);
      await observer.refresh();
      expect(await f.adapter.state(app.unitName!)).toBe("running");
      expect(f.service.get(app.id).desiredState).toBe("ready");
    } finally {
      release();
      await observation;
    }
  });

test("observer skips a deployment lease without inspecting or quarantining its in-flight release", async () => {
  const f = fixture();
  const app = await f.service.deploy(f.manifest);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.adapter.gate = async () => {
    entered();
    await pending;
  };
  let isolationChecks = 0;
  f.adapter.runtimeIsolation = async () => {
    isolationChecks++;
    return { safe: true, ready: true };
  };
  const deployment = f.service.deploy({ ...f.manifest, id: app.id });
  try {
    await started;
    f.adapter.actions = [];
    await (f.service as unknown as { refresh(): Promise<void> }).refresh();
    expect(isolationChecks).toBe(0);
    expect(f.adapter.actions.some(([action]) => action === "stop")).toBe(false);
    expect(f.service.get(app.id).desiredState).toBe("deploying");
    release();
    const healthy = await deployment;
    expect(healthy.deploymentRevision).not.toBe(app.deploymentRevision);
    expect(healthy.observation.httpHealthy).toBe(true);
    expect(await f.adapter.state(app.unitName!)).toBe("running");
    await (f.service as unknown as { refresh(): Promise<void> }).refresh();
    expect(f.service.get(app.id).desiredState).toBe("ready");
  } finally {
    release();
    await deployment;
  }
});

test("nullable linked origins clear independently and stay editable after both are cleared", () => {
  const f = fixture();
  const linked = f.service.register({
    name: "Linked",
    localOrigin: "http://127.0.0.2:8000",
    tailnetOrigin: "http://app.tailfixture.ts.net:8000",
  });
  const localCleared = f.service.register({ id: linked.id, localOrigin: null });
  expect(localCleared.localOrigin).toBeNull();
  expect(localCleared.tailnetOrigin).toBe(linked.tailnetOrigin);
  const bothCleared = f.service.register({
    id: linked.id,
    tailnetOrigin: null,
  });
  expect(bothCleared.localOrigin).toBeNull();
  expect(bothCleared.tailnetOrigin).toBeNull();
  expect(f.service.register({ id: linked.id, name: "Renamed" }).name).toBe(
    "Renamed",
  );
});

test("long dataDir paths use short stable instance/app sockets without runtime TCP allocation", async () => {
  const f = fixture();
  const dataDir = join(
    f.dir,
    "long-" + "a".repeat(110),
    "long-" + "b".repeat(110),
  );
  const service = new AppsService(f.store, {
    dataDir,
    adapter: f.adapter,
    socketBaseDir: join(f.dir, "short"),
    healthAttempts: 1,
    observationIntervalMs: 0,
  });
  cleanups.push(() => service.close());
  const app = await service.deploy(f.manifest);
  expect(Buffer.byteLength(app.runtimeSocket!)).toBeLessThanOrEqual(103);
  expect(app.runtimeSocket).not.toContain(dataDir);
  expect(
    f.store.db.query("SELECT kind FROM app_ports WHERE appId=?").all(app.id),
  ).toEqual([{ kind: "gateway" }]);
  expect(f.adapter.units.get(app.unitName!)).toContain(
    "SocketBindDeny=ipv4:tcp ipv6:tcp",
  );
  expect(
    f.adapter.units.get(unitName(f.store.instance().id, app.id, true)),
  ).not.toContain("SocketBindDeny=");
});

test("genuine v14 TCP resource migration retains reservations without adopting legacy services or exposing raw origins", async () => {
  const f = fixture();
  const draft = f.service.register({ id: "legacy-record", name: "Legacy" });
  await f.service.close();
  const { createHash } = await import("node:crypto");
  const oldName = `jelly-app-${createHash("sha256").update(draft.id).digest("hex").slice(0, 32)}.service`;
  const old = {
    ...draft,
    unitName: oldName,
    runtimePort: 39000,
    gatewayPort: 39001,
    deploymentRevision: "legacy-good",
    desiredState: "ready",
    localOrigin: "http://127.0.0.1:39001",
    tailnetOrigin: "http://fixture.tailfixture.ts.net:39001",
  };
  delete (old as Partial<typeof old>).runtimeSocket;
  f.store.db
    .query("UPDATE apps SET record=? WHERE id=?")
    .run(JSON.stringify(old), draft.id);
  f.store.db.exec(
    "DROP TABLE app_resources; CREATE TABLE app_resources(appId TEXT PRIMARY KEY,unitName TEXT NOT NULL UNIQUE,runtimePort INTEGER NOT NULL UNIQUE,gatewayPort INTEGER NOT NULL UNIQUE); PRAGMA user_version=14;",
  );
  f.store.db
    .query("INSERT INTO app_resources VALUES (?,?,?,?)")
    .run(draft.id, oldName, 39000, 39001);
  f.store.db
    .query("INSERT INTO app_ports VALUES (?,?,?)")
    .run(39000, draft.id, "runtime");
  f.adapter.units.set(oldName, `# Jelly-owned app: ${draft.id}\n`);
  const store = new Store(join(f.dir, "temporary.sqlite"));
  cleanups.push(() => store.close());
  const service = new AppsService(store, {
    dataDir: f.dir,
    adapter: f.adapter,
    observationIntervalMs: 0,
  });
  cleanups.push(() => service.close());
  expect(store.db.query("PRAGMA user_version").get()).toEqual({
    user_version: 15,
  });
  expect(
    store.db
      .query(
        "SELECT runtimeSocket,legacyRuntimePort FROM app_resources WHERE appId=?",
      )
      .get(draft.id),
  ).toEqual({ runtimeSocket: null, legacyRuntimePort: 39000 });
  expect(
    store.db.query("SELECT port FROM app_ports WHERE appId=?").all(draft.id),
  ).toEqual([{ port: 39000 }]);
  expect(service.get(draft.id).localOrigin).toBeNull();
  expect(service.get(draft.id).tailnetOrigin).toBeNull();
  expect(service.get(draft.id).runtimeSocket).toBeNull();
  expect(service.get(draft.id).observation.lastError).toContain("not adopted");
  await expect(service.control(draft.id, "restart")).rejects.toThrow(
    "ownership",
  );
  expect(f.adapter.actions).toEqual([]);
  expect(f.adapter.units.get(oldName)).toBe(`# Jelly-owned app: ${draft.id}\n`);
});

test("same-port cross-instance bind races cannot pass foreign gateway health or clean up the other instance", async () => {
  const first = fixture(),
    second = fixture();
  const service = new AppsService(second.store, {
    dataDir: second.dir,
    socketBaseDir: join(second.dir, "s"),
    adapter: first.adapter,
    healthAttempts: 1,
    observationIntervalMs: 0,
  });
  cleanups.push(() => service.close());
  const a = await first.service.deploy({ ...first.manifest, id: "same-app" });
  const original = first.adapter.units.get(a.unitName!);
  // Simulate simultaneous port probes before bind: both DBs reserve 32000 and
  // own systemd state briefly says running, but HTTP responds from instance one.
  first.adapter.gatewayIdentity = {
    instanceId: first.store.instance().id,
    appId: a.id,
    deploymentRevision: a.deploymentRevision!,
  };
  first.adapter.actions = [];
  await expect(
    service.deploy({ ...second.manifest, id: "same-app" }),
  ).rejects.toThrow("gateway health");
  const foreignNames = [
    a.unitName!,
    unitName(first.store.instance().id, a.id, true),
  ];
  expect(
    first.adapter.actions
      .flatMap(([, units]) => units)
      .some((name) => foreignNames.includes(name)),
  ).toBe(false);
  expect(first.adapter.units.get(a.unitName!)).toBe(original);
  expect(await first.adapter.state(a.unitName!)).toBe("running");
  expect(first.service.get(a.id).observation.httpHealthy).toBe(true);
  expect(service.get(a.id).desiredState).toBe("draft");
  expect(second.store.db.query("SELECT * FROM app_resources").all()).toEqual(
    [],
  );
});

test("an old gateway deployment revision cannot satisfy readiness for its new release", async () => {
  const f = fixture();
  const app = await f.service.deploy(f.manifest);
  f.adapter.gatewayIdentity = {
    instanceId: f.store.instance().id,
    appId: app.id,
    deploymentRevision: app.deploymentRevision!,
  };
  await expect(f.service.deploy({ ...f.manifest, id: app.id })).rejects.toThrow(
    "gateway health",
  );
  expect(f.service.get(app.id).deploymentRevision).toBe(app.deploymentRevision);
  expect(f.service.get(app.id).observation.httpHealthy).toBe(true); // Last-good rollback rechecks old identity.
});
