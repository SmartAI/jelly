import { afterEach, describe, expect, test, jest, spyOn } from "bun:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  stat,
  rm,
  writeFile,
  chmod,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopSessions,
  desktopAppAllowed,
  desktopMutationOutcome,
} from "../src/server/desktop-sessions";
import { DesktopLease } from "../src/server/desktop-lease";
import {
  syntheticConfig,
  SyntheticProvider,
  syntheticObservation,
  syntheticOutcome,
  syntheticApp,
  syntheticWindow,
} from "./peekaboo.test";

const roots: string[] = [],
  sessions: DesktopSessions[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0))
    await session.close().catch(() => {});
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function setup(
  options: {
    root?: string;
    dataDir?: string;
    provider?: SyntheticProvider;
    canAdmit?: () => boolean;
    isRunActive?: (agent: string, run: string) => boolean;
    platform?: string;
    consent?: boolean;
    start?: boolean;
  } = {},
) {
  const root =
    options.root ?? (await mkdtemp(join(tmpdir(), "jelly-desktop-test-")));
  if (!options.root) roots.push(root);
  const provider = options.provider ?? new SyntheticProvider();
  const session = new DesktopSessions(options.dataDir ?? join(root, "data"), {
    isRunActive: options.isRunActive ?? (() => true),
    notify: () => {},
    providerFactory: () => provider,
    leaseRoot: join(root, "leases"),
    platform: options.platform ?? "darwin",
    canAdmit: options.canAdmit,
  });
  sessions.push(session);
  if (options.start !== false) {
    await session.configure({
      ...syntheticConfig,
      captureConsent: options.consent ?? false,
    });
    await session.connect();
    await session.resume("agent-a", "run-a");
  }
  return { session, provider, root };
}
export async function observe(session: DesktopSessions, screenshot = false) {
  const apps = (await session.action("agent-a", "run-a", "apps")).data as any;
  const windows = (
    await session.action("agent-a", "run-a", "windows", {
      appRef: apps.apps[0].appRef,
    })
  ).data as any;
  const result = await session.action("agent-a", "run-a", "observe", {
    windowRef: windows.windows[0].windowRef,
    screenshot,
  });
  return { apps, windows, ...(result.data as any), image: result.image };
}

describe("DesktopSessions owner/config and admission", () => {
  test("older resume cannot override a newer pause or stop across lease validation", async () => {
    for (const operation of ["pause", "stop"] as const) {
      const { session } = await setup();
      await observe(session);
      await session.pause();
      const gate = deferred<void>(),
        started = deferred<void>();
      const original = DesktopLease.prototype.assertOwned;
      const hook = spyOn(
        DesktopLease.prototype,
        "assertOwned",
      ).mockImplementation(async function (this: DesktopLease) {
        started.resolve();
        await gate.promise;
        return original.call(this);
      });
      try {
        const result = session.resume("agent-a", "run-a").then(
          () => null,
          (error) => error,
        );
        await started.promise;
        await session[operation]();
        gate.resolve();
        expect(await result).toBeInstanceOf(Error);
        expect(session.status().control).toBe(
          operation === "stop" ? "stopped" : "paused",
        );
      } finally {
        gate.resolve();
        hook.mockRestore();
      }
    }
  });
  test("no-owner private pause reserves cross-instance exclusion until explicit handback", async () => {
    const first = await setup();
    const second = await setup({
      root: first.root,
      dataDir: join(first.root, "other"),
    });
    expect(first.session.status().owner).toBeNull();
    expect((await first.session.pauseForPrivacy()).control).toBe("paused");
    await expect(
      second.session.action("agent-b", "run-b", "apps"),
    ).rejects.toThrow("Desktop busy");
    await expect(first.session.resume("agent-a", "run-a")).rejects.toThrow(
      "admission",
    );
    await first.session.releasePrivateControl();
    expect(first.session.status().control).toBe("paused");
    await second.session.action("agent-b", "run-b", "apps");
  });
  test("private safety remains unconfirmed until deferred cross-instance acquisition succeeds or refuses", async () => {
    for (const foreignOwner of [false, true]) {
      const first = await setup();
      if (foreignOwner) await observe(first.session);
      const target = foreignOwner
        ? (
            await setup({
              root: first.root,
              dataDir: join(first.root, "other"),
            })
          ).session
        : first.session;
      const gate = deferred<void>(),
        started = deferred<void>();
      const original = DesktopLease.prototype.acquire;
      const hook = spyOn(DesktopLease.prototype, "acquire").mockImplementation(
        async function (this: DesktopLease) {
          started.resolve();
          await gate.promise;
          return original.call(this);
        },
      );
      try {
        const pending = target.pauseForPrivacy();
        expect(target.status().control).toBe("draining");
        expect(target.status().privateSafe).toBe(false);
        await started.promise;
        expect(target.status().privateSafe).toBe(false);
        gate.resolve();
        const settled = await pending;
        expect(settled.control).toBe(foreignOwner ? "unsafe" : "paused");
        expect(settled.privateSafe).toBe(!foreignOwner);
      } finally {
        gate.resolve();
        hook.mockRestore();
      }
    }
  });
  test("foreign admitted desktop work prevents a private-safe pause", async () => {
    const first = await setup();
    await observe(first.session);
    const second = await setup({
      root: first.root,
      dataDir: join(first.root, "other"),
    });
    expect((await second.session.pauseForPrivacy()).control).toBe("unsafe");
    await expect(second.session.releasePrivateControl()).rejects.toThrow(
      "unknown",
    );
    expect(second.provider.calls).toEqual(["connect"]);
  });
  test("private exclusion survives owner run settlement and shutdown; no implicit reclamation", async () => {
    const first = await setup();
    await observe(first.session);
    await first.session.pauseForPrivacy();
    await first.session.settle("agent-a", "run-a");
    expect(first.session.status().owner).toBeNull();
    expect(first.session.status().control).toBe("paused");
    const second = await setup({
      root: first.root,
      dataDir: join(first.root, "other"),
    });
    await expect(
      second.session.action("agent-b", "run-b", "apps"),
    ).rejects.toThrow("Desktop busy");
    await first.session.close();
    await expect(
      second.session.action("agent-b", "run-b", "apps"),
    ).rejects.toThrow("Desktop busy");
  });
  test("lease filesystem failures cannot disclose operator paths to model-facing errors", async () => {
    const { session, root } = await setup();
    await observe(session);
    await rm(join(root, "leases/desktop.lock"), { recursive: true });
    const error = await session.action("agent-a", "run-a", "apps").then(
      () => null,
      (error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(root);
    expect(error.message).not.toContain("/Users/");
  });
  test("every refusal reason matches the independent v4.9.0 Swift escalation table", () => {
    // Source: DesktopActionOutcome.swift RefusalReason.escalation, not the adapter's table.
    const cases = {
      invalid_request: "correct_request",
      permission_denied: "grant_permission",
      target_unavailable: "refresh_target",
      transport_session_unavailable: "reconnect_session",
      request_cancelled: "none",
      runtime_incompatible: "update_runtime",
      foreground_consent_required: "correct_request",
      operation_unsupported: "correct_request",
    };
    for (const [reason, escalation] of Object.entries(cases)) {
      const result = syntheticOutcome("refused") as {
        _meta: Record<string, unknown>;
      };
      result._meta.refusal_reason = reason;
      result._meta.escalation = escalation;
      const outcome = desktopMutationOutcome(result, syntheticWindow);
      expect(outcome.state).toBe("refused");
      expect(outcome.unsafe).toBe(false);
      expect(outcome.escalation).toBe(escalation);
    }
  });
  test("starts off; status is passive, synchronous and clone isolated", async () => {
    const { session, provider } = await setup({ start: false });
    expect(session.status().connection).toBe("disabled");
    expect(session.status().config.enabled).toBe(false);
    const status = session.status();
    status.config.allowedApps.push("com.test.Other");
    expect(session.status().config.allowedApps).toEqual([]);
    expect(provider.calls).toEqual([]);
    await session.pause();
    expect(session.status().control).toBe("paused");
  });
  test("owner-only configuration persists independently from SQLite", async () => {
    const { session, provider, root } = await setup();
    expect((await stat(join(root, "data/desktop.json"))).mode & 0o777).toBe(
      0o600,
    );
    const restored = await setup({ root, start: false });
    expect(restored.session.status().config).toEqual(session.status().config);
    expect(restored.session.status().control).toBe("paused");
    expect(restored.provider.calls).toEqual([]);
    expect(provider.calls).toEqual(["connect"]);
  });
  test("world-readable or malformed config is disabled and blocked", async () => {
    for (const content of ["not-json", JSON.stringify(syntheticConfig)]) {
      const { root } = await setup({ start: false });
      const path = join(root, "data");
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "desktop.json"), content, { mode: 0o644 });
      await chmod(join(path, "desktop.json"), 0o644);
      const { session } = await setup({ root, start: false });
      expect(session.status().config.enabled).toBe(false);
      expect(session.status().connection).toBe("blocked");
    }
  });
  test("configuration denies extra fields, relative paths and excluded apps", async () => {
    const { session } = await setup({ start: false });
    for (const input of [
      { ...syntheticConfig, unsigned: true },
      { ...syntheticConfig, cliPath: "peekaboo" },
      { ...syntheticConfig, allowedApps: ["com.apple.Safari"] },
      { ...syntheticConfig, allowedApps: ["com.google.Chrome"] },
      { ...syntheticConfig, allowedApps: ["com.apple.Terminal"] },
      { ...syntheticConfig, allowedApps: ["com.apple.systempreferences"] },
      { ...syntheticConfig, allowedApps: ["boo.peekaboo.mac"] },
      { ...syntheticConfig, allowedApps: ["com.agilebits.onepassword"] },
      {
        ...syntheticConfig,
        allowedApps: [
          "com.example.SyntheticFixture",
          "com.example.SyntheticFixture",
        ],
      },
    ])
      await expect(session.configure(input)).rejects.toThrow();
    expect(session.status().config.enabled).toBe(false);
  });
  test("reconnect clears earlier host capabilities and permissions before and after refusal", async () => {
    const { session, provider } = await setup();
    expect(session.status().capabilities.observe).toBe(true);
    expect(session.status().host).not.toBeNull();
    const pending =
      deferred<Awaited<ReturnType<SyntheticProvider["connect"]>>>();
    provider.connect = () => pending.promise;
    const connecting = session.connect();
    expect(session.status()).toMatchObject({
      connection: "connecting",
      host: null,
      capabilities: {
        observe: false,
        click: false,
        type: false,
        images: false,
      },
      permissions: {
        accessibility: null,
        screenRecording: null,
        syntheticInput: null,
      },
    });
    pending.resolve({ qualified: false, reason: "Replacement is unqualified" });
    expect(await connecting).toMatchObject({
      connection: "blocked",
      host: null,
      capabilities: { observe: false, click: false },
      permissions: {
        accessibility: null,
        screenRecording: null,
        syntheticInput: null,
      },
    });
    await expect(session.resume("agent-a", "run-a")).rejects.toThrow();
    await expect(session.action("agent-a", "run-a", "apps")).rejects.toThrow();
  });
  test("platform and unsupported/unknown qualification fail closed", async () => {
    const linux = await setup({ start: false, platform: "linux" });
    await linux.session.configure(syntheticConfig);
    expect((await linux.session.connect()).connection).toBe("blocked");
    expect(linux.provider.calls).toEqual([]);
    const provider = new SyntheticProvider();
    provider.qualification = {
      qualified: false,
      reason: "Source inventory/identity missing",
    };
    const fixture = await setup({ start: false, provider });
    await fixture.session.configure(syntheticConfig);
    expect((await fixture.session.connect()).connection).toBe("blocked");
    await expect(fixture.session.resume("agent-a", "run-a")).rejects.toThrow();
    for (const patch of [
      { version: "5.0.0" },
      { generation: "" },
      { contracts: {} },
      { permissions: { accessibility: null } },
    ]) {
      const fake = new SyntheticProvider();
      fake.qualification = { ...fake.qualification, ...patch } as any;
      const { session } = await setup({ start: false, provider: fake });
      await session.configure(syntheticConfig);
      expect((await session.connect()).connection).toBe("blocked");
      expect(session.status().capabilities.observe).toBe(false);
    }
  });
  test("canAdmit gates enable, connect, resume and every provider operation", async () => {
    let admitted = true;
    const { session, provider } = await setup({ canAdmit: () => admitted });
    admitted = false;
    await expect(session.action("agent-a", "run-a", "apps")).rejects.toThrow(
      "admission",
    );
    await expect(session.resume("agent-a", "run-a")).rejects.toThrow(
      "admission",
    );
    await expect(session.connect()).rejects.toThrow("admission");
    await expect(session.configure({ captureConsent: true })).rejects.toThrow(
      "admission",
    );
    expect(provider.calls).toEqual(["connect"]);
    const paused = await session.pause();
    expect(paused.control).toBe("paused");
    admitted = true;
    await expect(session.action("agent-a", "run-a", "apps")).rejects.toThrow(
      "explicitly resume",
    );
  });
  test("canAdmit is not cached across connect awaits", async () => {
    let admitted = true;
    const provider = new SyntheticProvider(),
      entered = deferred<void>(),
      wait = deferred<void>();
    provider.onConnect = async () => {
      entered.resolve();
      await wait.promise;
    };
    const { session } = await setup({
      start: false,
      provider,
      canAdmit: () => admitted,
    });
    await session.configure(syntheticConfig);
    const connecting = session.connect();
    await entered.promise;
    admitted = false;
    wait.resolve();
    expect((await connecting).connection).toBe("blocked");
    expect(session.status().capabilities.observe).toBe(false);
  });
  test("configuration enable rechecks private admission after persistence awaits", async () => {
    let checks = 0;
    const { session, root } = await setup({
      start: false,
      canAdmit: () => ++checks < 2,
    });
    await expect(session.configure(syntheticConfig)).rejects.toThrow(
      "admission",
    );
    expect(session.status().config.enabled).toBe(false);
    await expect(readFile(join(root, "data/desktop.json"))).rejects.toThrow();
  });
  test("run owner retains lease over tool turns and foreign agents cannot interleave", async () => {
    const { session } = await setup();
    const refs = await observe(session);
    expect(session.status().owner).toEqual({
      agentId: "agent-a",
      runId: "run-a",
    });
    await expect(session.action("agent-b", "run-b", "apps")).rejects.toThrow(
      "busy",
    );
    await expect(
      session.action("agent-b", "run-b", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
    ).rejects.toThrow("busy");
    await expect(session.pauseForRun("agent-b", "run-b")).rejects.toThrow(
      "busy",
    );
    await session.settle("agent-b", "run-b");
    expect(session.status().owner?.agentId).toBe("agent-a");
    await session.settle("agent-a", "run-a");
    expect(session.status().owner).toBeNull();
  });
  test("two instances share a lease and safe complete settlement releases it", async () => {
    const first = await setup(),
      second = await setup({
        root: first.root,
        dataDir: join(first.root, "other-data"),
      });
    await observe(first.session);
    await expect(
      second.session.action("agent-a", "run-a", "apps"),
    ).rejects.toThrow("another instance");
    await first.session.settle("agent-a", "run-a");
    expect(
      (await second.session.action("agent-a", "run-a", "apps")).data,
    ).toBeDefined();
  });
  test("orphan/old PID lease is not reclaimed", async () => {
    const { session, root, provider } = await setup();
    await mkdir(join(root, "leases/desktop.lock"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(root, "leases/desktop.lock/owner.json"),
      JSON.stringify({ pid: 9999999, timestamp: 0 }),
      { mode: 0o600 },
    );
    await expect(session.action("agent-a", "run-a", "apps")).rejects.toThrow(
      "never reclaimed",
    );
    expect(provider.calls).toEqual(["connect"]);
  });
  test("real cooperating processes exclude each other; dead PID is still not reclaimed", async () => {
    const { root } = await setup({ start: false });
    const leaseRoot = join(root, "process-leases");
    const module = join(import.meta.dir, "../src/server/desktop-lease.ts");
    const program = `import {DesktopLease} from ${JSON.stringify(module)}; const lease=new DesktopLease(${JSON.stringify(leaseRoot)},{agentId:'synthetic',runId:'synthetic'});await lease.acquire();process.stdout.write('OWNED\\n');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", program], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code) reject(new Error("synthetic lease process failed"));
        });
      });
      const competitor = `import {DesktopLease} from ${JSON.stringify(module)};try{await new DesktopLease(${JSON.stringify(leaseRoot)},{agentId:'other',runId:'other'}).acquire();process.stdout.write('UNSAFE')}catch{process.stdout.write('BUSY')}`;
      expect(
        (await promisify(execFile)(process.execPath, ["-e", competitor]))
          .stdout,
      ).toBe("BUSY");
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      await exited;
      expect(
        (await promisify(execFile)(process.execPath, ["-e", competitor]))
          .stdout,
      ).toBe("BUSY");
    } finally {
      child.kill("SIGTERM");
    }
  });
  test("inactive run and pre-aborted action never call provider", async () => {
    let active = true;
    const { session, provider } = await setup({ isRunActive: () => active });
    active = false;
    await expect(session.action("agent-a", "run-a", "apps")).rejects.toThrow(
      "inactive",
    );
    active = true;
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      session.action("agent-a", "run-a", "apps", {}, cancelled.signal),
    ).rejects.toThrow();
    expect(provider.calls).toEqual(["connect"]);
  });
});

describe("DesktopSessions references/privacy/mutations", () => {
  test("opaque refs and no provider values, labels, titles, PID or snapshots reach model", async () => {
    const { session, provider } = await setup();
    const refs = await observe(session);
    const serialized = JSON.stringify(refs);
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain("9007199254740993");
    expect(serialized).not.toContain("synthetic-snapshot");
    const result = await session.action("agent-a", "run-a", "click", {
      elementRef: refs.elements[0].elementRef,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(provider.mutations[0]?.target.processStart).toBe("9007199254740993");
    expect(provider.mutations[0]?.snapshotId).toBe("synthetic-snapshot");
  });
  test("mutations, handoff, run invalidation and new observation revoke stale refs", async () => {
    for (const invalidate of [
      "mutation",
      "pause",
      "run",
      "observation",
    ] as const) {
      const { session, provider } = await setup();
      const refs = await observe(session);
      if (invalidate === "mutation")
        await session.action("agent-a", "run-a", "click", {
          elementRef: refs.elements[0].elementRef,
        });
      if (invalidate === "pause") {
        await session.pause();
        await session.resume("agent-a", "run-a");
      }
      if (invalidate === "run") session.invalidateRun("agent-a", "run-a");
      if (invalidate === "observation")
        await session.action("agent-a", "run-a", "observe", {
          windowRef: refs.windowRef,
        });
      const count = provider.mutations.length;
      await expect(
        session.action("agent-a", "run-a", "click", {
          elementRef: refs.elements[0].elementRef,
        }),
      ).rejects.toThrow("Stale");
      expect(provider.mutations.length).toBe(count);
    }
  });
  test("foreign session refs and expired snapshots cannot dispatch", async () => {
    const first = await setup(),
      refs = await observe(first.session);
    await first.session.settle("agent-a", "run-a");
    const second = await setup({
      root: first.root,
      dataDir: join(first.root, "new-session"),
    });
    await expect(
      second.session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
    ).rejects.toThrow("Stale");
    const fresh = await observe(second.session),
      clock = spyOn(Date, "now").mockReturnValue(Date.now() + 16000);
    try {
      await expect(
        second.session.action("agent-a", "run-a", "key", {
          observationRef: fresh.observationRef,
          key: "Enter",
        }),
      ).rejects.toThrow("expired");
      expect(second.provider.mutations).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });
  test("run compaction during lease await fences mutation before dispatch", async () => {
    const { session, provider } = await setup(),
      refs = await observe(session),
      entered = deferred<void>(),
      wait = deferred<void>();
    const lease = (session as any).lease,
      original = lease.assertOwned.bind(lease);
    lease.assertOwned = async () => {
      entered.resolve();
      await wait.promise;
      await original();
    };
    const pending = session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
      caught = pending.catch((error) => error);
    await entered.promise;
    session.invalidateRun("agent-a", "run-a");
    wait.resolve();
    expect(String(await caught)).toContain("revoked before dispatch");
    expect(provider.mutations).toEqual([]);
    lease.assertOwned = original;
  });
  test("malformed and oversized normalized inventory cannot become authority", async () => {
    for (const rows of [
      [{ ...syntheticApp, processStart: 9007199254740992 }],
      Array(101).fill(syntheticApp),
      [{ ...syntheticApp, unexpected: "x".repeat(7 * 1024 * 1024) }],
    ]) {
      const provider = new SyntheticProvider();
      provider.appRows = rows as any;
      const { session } = await setup({ provider });
      await expect(session.action("agent-a", "run-a", "apps")).rejects.toThrow(
        "completion is unknown",
      );
      expect(session.status().control).toBe("unsafe");
    }
  });
  test("raw IDs, selectors, executable paths and coordinate/foreground arguments are rejected", async () => {
    const { session, provider } = await setup();
    const refs = await observe(session);
    for (const args of [
      { elementRef: "button" },
      { elementRef: refs.elements[0].elementRef, foreground: true },
      { elementRef: refs.elements[0].elementRef, coords: "1,1" },
      { elementRef: refs.elements[0].elementRef, pid: 123 },
      { elementRef: refs.elements[0].elementRef, path: "/tmp/private" },
    ])
      await expect(
        session.action("agent-a", "run-a", "click", args),
      ).rejects.toThrow();
    expect(provider.mutations).toEqual([]);
    await expect(
      session.grantForeground("agent-a", "run-a", 1000),
    ).rejects.toThrow("Foreground");
    await expect(
      session.action("agent-a", "run-a", "menu", {}),
    ).rejects.toThrow("Menu input");
    await expect(
      session.action("agent-a", "run-a", "scroll", {}),
    ).rejects.toThrow("scroll capability");
  });
  test("literal typing and bounded keys use exact target/snapshot, never clipboard chords", async () => {
    const { session, provider } = await setup();
    let refs = await observe(session);
    for (const key of [
      "Cmd+C",
      "Cmd+V",
      "Ctrl+A",
      "Option+Return",
      "Meta+X",
      "a",
    ])
      await expect(
        session.action("agent-a", "run-a", "key", {
          observationRef: refs.observationRef,
          key,
        }),
      ).rejects.toThrow("allowlisted");
    await expect(
      session.action("agent-a", "run-a", "key", {
        observationRef: refs.observationRef,
        key: "Tab",
        count: 100,
      }),
    ).rejects.toThrow();
    await session.action("agent-a", "run-a", "type", {
      elementRef: refs.elements[1].elementRef,
      text: "synthetic text",
    });
    expect(provider.mutations[0]?.text).toBe("synthetic text");
    refs = await observe(session);
    await session.action("agent-a", "run-a", "key", {
      observationRef: refs.observationRef,
      key: "Shift+Tab",
      count: 2,
    });
    expect(provider.mutations[1]?.key).toBe("Shift+Tab");
  });
  test("changed window/process/geometry and malformed observation are unsafe, no input", async () => {
    for (const change of [
      { target: { ...syntheticWindow, processStart: "9007199254740992" } },
      { target: { ...syntheticWindow, windowId: 457 } },
      {
        target: {
          ...syntheticWindow,
          bounds: { ...syntheticWindow.bounds, x: 200 },
        },
      },
      { fresh: false },
      { snapshotId: "" },
      { elements: Array(201).fill(syntheticObservation().elements[0]) },
    ]) {
      const provider = new SyntheticProvider();
      provider.observation = { ...syntheticObservation(), ...change } as any;
      const { session } = await setup({ provider });
      await expect(observe(session)).rejects.toThrow("completion is unknown");
      expect(provider.mutations).toEqual([]);
      expect(session.status().control).toBe("unsafe");
    }
  });
  test("secure, unknown, sparse, dialog and custom surfaces never publish/read values or screenshots", async () => {
    for (const change of [
      { privacy: "secure" },
      { privacy: "unknown" },
      { surface: "custom" },
      { surface: "dialog" },
      { elements: [] },
      { elements: [{ id: "secret", role: "AXSecureTextField", secure: true }] },
      {
        elements: [
          { ...syntheticObservation().elements[0], secure: undefined },
        ],
      },
    ]) {
      const provider = new SyntheticProvider();
      provider.observation = { ...syntheticObservation(), ...change } as any;
      const { session } = await setup({ provider, consent: true });
      await expect(observe(session, true)).rejects.toThrow();
      expect(session.status().control).toBe("unsafe");
    }
  });
  test("capture consent checked before provider and unexpected image blocks fail", async () => {
    const { session, provider } = await setup();
    const apps = (await session.action("agent-a", "run-a", "apps")).data as any;
    const windows = (
      await session.action("agent-a", "run-a", "windows", {
        appRef: apps.apps[0].appRef,
      })
    ).data as any;
    await expect(
      session.action("agent-a", "run-a", "observe", {
        windowRef: windows.windows[0].windowRef,
        screenshot: true,
      }),
    ).rejects.toThrow("consent");
    expect(provider.calls).not.toContain("observe");
    provider.onObserve = async () => ({
      ...syntheticObservation(),
      image: { type: "image", mimeType: "image/png", data: "invalid" },
    });
    await expect(
      session.action("agent-a", "run-a", "observe", {
        windowRef: windows.windows[0].windowRef,
      }),
    ).rejects.toThrow();
  });
  test("partial and error/uncertain receipts preserve closed evidence, quarantine; never replay or release", async () => {
    for (const state of [
      "partial",
      "dispatched_unverified",
      "indeterminate",
      "suspected_noop",
    ]) {
      const { session, provider, root } = await setup();
      provider.outcome = syntheticOutcome(state);
      const refs = await observe(session);
      const result = await session.action("agent-a", "run-a", "type", {
        elementRef: refs.elements[1].elementRef,
        text: "synthetic",
      });
      expect((result.data as any).state).toBe(state);
      expect((result.data as any).unsafe).toBe(true);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(session.status().control).toBe("unsafe");
      await expect(session.resume("agent-a", "run-a")).rejects.toThrow(
        "no qualifying drain",
      );
      await expect(session.settle("agent-a", "run-a")).rejects.toThrow();
      const second = await setup({ root, dataDir: join(root, "second") });
      await expect(
        second.session.action("agent-a", "run-a", "apps"),
      ).rejects.toThrow("quarantined");
      expect(provider.mutations.length).toBe(1);
    }
  });
  test("confirmed no-change/refusal are terminal zero-dispatch, but never imply successful action", () => {
    expect(
      desktopMutationOutcome(
        syntheticOutcome("confirmed_no_change"),
        syntheticWindow,
      ),
    ).toMatchObject({
      state: "confirmed_no_change",
      dispatch: "none",
      unsafe: false,
    });
    expect(
      desktopMutationOutcome(syntheticOutcome("refused"), syntheticWindow),
    ).toMatchObject({
      state: "refused",
      refusalReason: "invalid_request",
      unsafe: false,
    });
  });
  test("contradictory/missing/local/foreign target action metadata is never treated as no mutation", async () => {
    for (const extra of [
      { mutation_dispatched: false },
      { retry_safe: true },
      { requires_fresh_observation: true },
      { route: "local" },
      { delivery_mode: "foreground" },
      {
        target_identity: {
          kind: "window",
          pid: 123,
          window_id: 456,
          process_start_identity_decimal: "9007199254740992",
        },
      },
      { target_identity: undefined },
      { state: "future_success" },
    ]) {
      expect(() =>
        desktopMutationOutcome(
          syntheticOutcome("confirmed_change", extra),
          syntheticWindow,
        ),
      ).toThrow();
    }
    const { session, provider } = await setup();
    provider.outcome = {
      isError: true,
      content: [{ type: "text", text: "nothing happened" }],
    };
    const refs = await observe(session);
    await expect(
      session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
    ).rejects.toThrow("completion is unknown");
    expect(session.status().control).toBe("unsafe");
  });
});

describe("DesktopSessions cancellation, late publication and process loss", () => {
  test("concurrent tools return busy without a second provider call", async () => {
    const { session, provider } = await setup();
    const refs = await observe(session);
    const wait = deferred<any>(),
      entered = deferred<void>();
    provider.onObserve = async () => {
      entered.resolve();
      return wait.promise;
    };
    const pending = session.action("agent-a", "run-a", "observe", {
      windowRef: refs.windowRef,
    });
    await entered.promise;
    await expect(session.action("agent-a", "run-a", "apps")).rejects.toThrow(
      "busy",
    );
    wait.resolve(syntheticObservation());
    await pending;
  });
  test("pause immediately suppresses late observation/images and retains durable quarantine after close", async () => {
    const { session, provider, root } = await setup();
    const refs = await observe(session);
    const wait = deferred<any>(),
      entered = deferred<void>();
    provider.onObserve = async () => {
      entered.resolve();
      return wait.promise;
    };
    const pending = session.action("agent-a", "run-a", "observe", {
      windowRef: refs.windowRef,
    });
    const rejection = pending.catch((error) => error);
    await entered.promise;
    expect((await session.pause()).control).toBe("unsafe");
    expect(String(await rejection)).toContain("completion is unknown");
    wait.resolve({
      ...syntheticObservation(),
      image: {
        type: "image",
        mimeType: "image/png",
        data: "PRIVATE_LATE_IMAGE",
      },
    });
    await Promise.resolve();
    await session.close();
    const owner = JSON.parse(
      await readFile(join(root, "leases/desktop.lock/owner.json"), "utf8"),
    );
    expect(owner.state).toBe("quarantined");
    const second = await setup({ root, dataDir: join(root, "next") });
    await expect(
      second.session.action("agent-a", "run-a", "apps"),
    ).rejects.toThrow("quarantined");
  });
  test("abort racing accepted mutation and late confirmed success never clears unsafe/replays", async () => {
    const { session, provider } = await setup();
    const refs = await observe(session);
    const wait = deferred<unknown>(),
      entered = deferred<void>();
    provider.onMutate = async () => {
      entered.resolve();
      return wait.promise;
    };
    const controller = new AbortController(),
      pending = session.action(
        "agent-a",
        "run-a",
        "click",
        { elementRef: refs.elements[0].elementRef },
        controller.signal,
      );
    const rejection = pending.catch((error) => error);
    await entered.promise;
    controller.abort();
    expect(String(await rejection)).toContain("completion is unknown");
    wait.resolve(syntheticOutcome());
    await Promise.resolve();
    expect(session.status().control).toBe("unsafe");
    await expect(session.resume("agent-a", "run-a")).rejects.toThrow();
    expect(provider.mutations.length).toBe(1);
  });
  test("run invalidation aborts accepted work and suppresses results", async () => {
    const { session, provider } = await setup();
    const refs = await observe(session);
    const wait = deferred<any>(),
      entered = deferred<void>();
    provider.onObserve = async () => {
      entered.resolve();
      return wait.promise;
    };
    const pending = session.action("agent-a", "run-a", "observe", {
        windowRef: refs.windowRef,
      }),
      rejection = pending.catch((error) => error);
    await entered.promise;
    session.invalidateRun("agent-a", "run-a");
    expect(String(await rejection)).toContain("completion is unknown");
    wait.resolve(syntheticObservation());
    expect(session.status().control).toBe("unsafe");
  });
  test("private admission closing across an await suppresses provider publication and blocks resume", async () => {
    let admitted = true;
    const { session, provider } = await setup({ canAdmit: () => admitted });
    const refs = await observe(session);
    const wait = deferred<any>(),
      entered = deferred<void>();
    provider.onObserve = async () => {
      entered.resolve();
      return wait.promise;
    };
    const pending = session.action("agent-a", "run-a", "observe", {
        windowRef: refs.windowRef,
      }),
      rejection = pending.catch((error) => error);
    await entered.promise;
    admitted = false;
    wait.resolve(syntheticObservation());
    expect(String(await rejection)).toContain("completion is unknown");
    admitted = true;
    expect(session.status().control).toBe("unsafe");
    await expect(session.resume("agent-a", "run-a")).rejects.toThrow();
  });
  test("timeout revokes proxy work but cannot establish host completion", async () => {
    const { session, provider } = await setup(),
      refs = await observe(session),
      entered = deferred<void>(),
      wait = deferred<unknown>();
    provider.onMutate = async () => {
      entered.resolve();
      return wait.promise;
    };
    jest.useFakeTimers();
    try {
      const pending = session.action("agent-a", "run-a", "click", {
          elementRef: refs.elements[0].elementRef,
        }),
        caught = pending.catch((error) => error);
      await entered.promise;
      jest.advanceTimersByTime(15000);
      expect(String(await caught)).toContain("completion is unknown");
      expect(session.status().control).toBe("unsafe");
      wait.resolve(syntheticOutcome());
      await Promise.resolve();
      expect(session.status().control).toBe("unsafe");
    } finally {
      jest.useRealTimers();
    }
  });
  test("listener disconnect revokes refs and capabilities even between tool turns", async () => {
    const { session, provider } = await setup(),
      refs = await observe(session);
    provider.onDisconnect?.();
    expect(session.status().connection).toBe("blocked");
    expect(session.status().control).toBe("paused");
    expect(session.status().capabilities.click).toBe(false);
    await expect(
      session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
    ).rejects.toThrow();
    expect(provider.mutations).toEqual([]);
  });
  test("disconnect during accepted mutation cannot drain by closing the proxy", async () => {
    const { session, provider } = await setup(),
      refs = await observe(session),
      entered = deferred<void>(),
      wait = deferred<unknown>();
    provider.onMutate = async () => {
      entered.resolve();
      return wait.promise;
    };
    const pending = session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
      caught = pending.catch((error) => error);
    await entered.promise;
    provider.onDisconnect?.();
    expect(String(await caught)).toContain("completion is unknown");
    await session.close();
    wait.resolve(syntheticOutcome());
    expect(session.status().control).toBe("unsafe");
  });
  test("connection drop/rejected mutation is unknown, not zero dispatch; raw error content is redacted", async () => {
    const { session, provider } = await setup();
    const refs = await observe(session);
    provider.onMutate = async () => {
      throw new Error("PRIVATE_TOKEN response lost");
    };
    try {
      await session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      });
      throw new Error("expected error");
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_TOKEN");
      expect(String(error)).toContain("completion is unknown");
    }
    await expect(session.settle("agent-a", "run-a")).rejects.toThrow();
  });
});
