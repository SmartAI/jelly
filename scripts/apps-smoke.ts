/** Opt-in real Linux/systemd/Tailscale smoke. Owns only UUID-named test apps and temp storage.
 * Never reads the live registry, restarts Jelly, reboots, or changes production source. */
import { strict as assert } from "node:assert";
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app";
import {
  SystemAppsAdapter,
  unitName,
  unitOwner,
} from "../src/server/apps-runtime";
import { tailscaleNetwork } from "./tailscale";
import {
  runtimeSocketPath,
  removeRuntimeSocket,
} from "../src/server/apps-sockets";
import type { AppRecord } from "../src/shared/apps";

const root = await mkdtemp(join(tmpdir(), "jelly-owned-apps-smoke-"));
const instance = join(root, "instance % $ space");
const source = join(root, "template-source");
const ids = [
  "smoke-" + crypto.randomUUID(),
  "smoke-" + crypto.randomUUID(),
  "smoke-" + crypto.randomUUID(),
  "smoke-" + crypto.randomUUID(),
  "smoke-" + crypto.randomUUID(),
];
const adapter = new SystemAppsAdapter();
let jelly: Awaited<ReturnType<typeof startApp>> | undefined;
let cleanupComplete = false;
let instanceId: string | undefined;
const ownedName = (id: string, gateway = false) => {
  assert.ok(instanceId);
  return unitName(instanceId, id, gateway);
};
const evidence: Record<string, unknown> = {
  root,
  ids,
  hostReboot: "not performed",
  realPhoneSafari: "not performed",
};
async function systemd(args: string[]) {
  const result = await adapter.command("systemctl", ["--user", ...args], {
    cwd: homedir(),
    env: {},
    timeoutMs: 10000,
  });
  assert.equal(result.code, 0, `systemctl ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
async function verify(app: AppRecord) {
  assert.equal(await adapter.state(app.unitName!), "running");
  assert.equal(await adapter.state(ownedName(app.id, true)), "running");
  assert.deepEqual(
    await adapter.runtimeIsolation(app.unitName!, app.runtimeSocket!, {
      instanceId: instanceId!,
      appId: app.id,
    }),
    { safe: true, ready: true },
  );
  assert.equal(await adapter.socketHealth(app.runtimeSocket!, "/health"), true);
  assert.equal(await systemd(["is-enabled", app.unitName!]), "enabled");
  assert.equal(
    await systemd(["is-enabled", ownedName(app.id, true)]),
    "enabled",
  );
  const local = await fetch(app.localOrigin! + "/health", {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get("x-jelly-instance-id"), instanceId);
  assert.equal(local.headers.get("x-jelly-app-id"), app.id);
  assert.equal(
    local.headers.get("x-jelly-deployment-revision"),
    app.deploymentRevision,
  );
  assert.deepEqual(await local.json(), { ok: true });
  assert.ok(
    app.tailnetOrigin,
    "Tailscale discovery must provide an actual private origin for this smoke",
  );
  const tailnet = await fetch(app.tailnetOrigin + "/health", {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(tailnet.status, 200);
  assert.equal(tailnet.headers.get("x-jelly-instance-id"), instanceId);
  assert.equal(tailnet.headers.get("x-jelly-app-id"), app.id);
  assert.equal(
    tailnet.headers.get("x-jelly-deployment-revision"),
    app.deploymentRevision,
  );
  assert.deepEqual(await tailnet.json(), { ok: true });
  return {
    rawRuntimeTransport: "owner-only Unix socket; no TCP listener",
    localHTTP: 200,
    tailnetHTTPFromThisHost: 200,
    localOrigin: app.localOrigin,
    tailnetOrigin: app.tailnetOrigin,
    runtimePID: await systemd([
      "show",
      app.unitName!,
      "-p",
      "MainPID",
      "--value",
    ]),
    gatewayPID: await systemd([
      "show",
      ownedName(app.id, true),
      "-p",
      "MainPID",
      "--value",
    ]),
    enabledForBoot: true,
    runtimeSocketOnly: true,
  };
}
try {
  const capabilities = await adapter.capabilities();
  evidence.capabilities = capabilities;
  assert.equal(
    capabilities.managedDeployment,
    true,
    capabilities.warnings.join(" "),
  );
  assert.equal(
    capabilities.tailscale,
    true,
    "This smoke requires actual connected Tailscale",
  );
  await mkdir(instance, { recursive: true, mode: 0o700 });
  await cp(new URL("../templates/apps/", import.meta.url), source, {
    recursive: true,
  });
  const environmentFile = join(root, "environment % $ space.env");
  await writeFile(
    environmentFile,
    "HOST=0.0.0.0\nPORT=1\nAPP_DATA_DIR=/invalid\nJELLY_APP_ID=forged\nJELLY_ALLOWED_ORIGINS=invalid\nJELLY_VIEWER_CORNER=bad\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(source, "fail.ts"),
    "Bun.serve({unix:process.env.APP_SOCKET!,fetch:()=>new Response('Not healthy',{status:503})});\n",
  );
  const options = {
    dataDir: instance,
    configDir: join(root, "config"),
    authPath: join(root, "auth.json"),
    port: 0,
    appsAdapter: adapter,
    allowedOrigins: [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://[::1]:5173",
      ...(await tailscaleNetwork(5173)).origins,
    ],
  };
  jelly = await startApp(options);
  instanceId = jelly.service.store.instance().id;
  evidence.instanceId = instanceId;
  evidence.allowedOrigins = options.allowedOrigins;
  const publish = (id: string) =>
    jelly!.service.apps.deploy({
      id,
      slug: id,
      name: id,
      sourceDirectory: source,
      executable: process.execPath,
      args: ["server.ts"],
      environmentFiles: [environmentFile],
      test: { executable: process.execPath, args: ["test", "app.test.ts"] },
      healthPath: "/health",
      migrationPlan:
        "Disposable unchanged note format; no user data or migrations.",
    });
  const one = await publish(ids[0]!);
  const two = await publish(ids[1]!);
  assert.equal(one.starredAt, null);
  assert.equal(one.lastOpenedAt, null);
  const initial = await verify(one);
  evidence.initial = initial;
  evidence.second = await verify(two);
  const note = await readFile(
    join(instance, "apps", "data", one.id, "note.json"),
    "utf8",
  );
  await jelly.close();
  jelly = undefined;
  const surviving = await verify(one);
  assert.equal(surviving.runtimePID, initial.runtimePID);
  assert.equal(surviving.gatewayPID, initial.gatewayPID);
  evidence.afterTemporaryJellyClose = surviving;
  jelly = await startApp(options);
  assert.equal(
    jelly.service.apps.get(one.id).deploymentRevision,
    one.deploymentRevision,
  );
  await jelly.service.apps.control(one.id, "stop");
  assert.equal(await adapter.state(one.unitName!), "stopped");
  assert.equal((await fetch(two.localOrigin! + "/health")).status, 200);
  await jelly.service.apps.control(one.id, "start");
  await verify(jelly.service.apps.get(one.id));
  await jelly.service.apps.control(one.id, "restart");
  await verify(jelly.service.apps.get(one.id));
  assert.equal(
    await readFile(join(instance, "apps", "data", one.id, "note.json"), "utf8"),
    note,
  );
  const removed = await jelly.service.apps.remove(one.id, { uninstall: false });
  assert.deepEqual(removed, {
    removed: true,
    serviceRetained: true,
    dataRetained: true,
  });
  await verify(one);
  const uninstalled = await jelly.service.apps.remove(two.id, {
    uninstall: true,
  });
  assert.deepEqual(uninstalled, {
    removed: true,
    serviceRetained: false,
    dataRetained: true,
  });
  assert.equal(await adapter.readUnit(two.unitName!), null);
  assert.equal(await adapter.readUnit(ownedName(two.id, true)), null);
  assert.ok(
    await readFile(join(instance, "apps", "data", two.id, "note.json"), "utf8"),
  );
  assert.ok(await readFile(join(source, "server.ts"), "utf8"));
  await assert.rejects(
    publish(ids[2]!).then(async (app) => {
      // A fresh failed activation must stop/disable before removing files and boot links.
      await jelly!.service.apps.remove(app.id, { uninstall: true });
      return jelly!.service.apps.deploy({
        id: app.id,
        name: app.name,
        sourceDirectory: source,
        executable: process.execPath,
        args: ["fail.ts"],
        test: { executable: process.execPath, args: ["test", "app.test.ts"] },
      });
    }),
    /health/,
  );
  for (const name of [ownedName(ids[2]!), ownedName(ids[2]!, true)]) {
    assert.equal(await adapter.readUnit(name), null);
    const { lstat } = await import("node:fs/promises");
    await assert.rejects(
      lstat(join(homedir(), ".config/systemd/user/default.target.wants", name)),
      { code: "ENOENT" },
    );
  }
  evidence.failedActivationCleanup = "No remaining owned units/boot links";
  const node = await adapter.gatewayExecutable();
  await writeFile(
    join(source, "node-server.mjs"),
    `import {createServer} from 'node:http'; const server=createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({ok:true}));}); server.listen(process.env.APP_SOCKET);`,
  );
  const nodeApp = await jelly.service.apps.deploy({
    id: ids[3]!,
    name: ids[3]!,
    sourceDirectory: source,
    executable: node,
    args: ["node-server.mjs"],
    test: { executable: process.execPath, args: ["test", "app.test.ts"] },
  });
  evidence.nodeSocketRuntime = await verify(nodeApp);
  await jelly.service.apps.remove(nodeApp.id, { uninstall: true });
  const outboundTarget = `http://127.0.0.1:${jelly.server.port}/api/health`;
  const childProbe = `const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const server=http.createServer((req,res)=>res.end(req.headers.cookie||''));server.on('error',error=>{fs.writeFileSync(path.join(process.env.APP_DATA_DIR,'bind-probe.json'),JSON.stringify({denied:error.code}));console.log('denied');process.exit(0);});server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(path.join(process.env.APP_DATA_DIR,'bind-probe.json'),JSON.stringify({port:server.address().port}));console.log('listening');});`;
  await writeFile(
    join(source, "binding-probe.ts"),
    `import {join} from 'node:path';const response=await fetch(${JSON.stringify(outboundTarget)});await Bun.write(join(process.env.APP_DATA_DIR!,'outbound-status.txt'),String(response.status));const child=Bun.spawn([${JSON.stringify(node)},'-e',${JSON.stringify(childProbe)}],{stdout:'pipe',stderr:'inherit'});await child.stdout.getReader().read();Bun.serve({unix:process.env.APP_SOCKET!,fetch:()=>Response.json({ok:true})});`,
  );
  let unsafeApp: AppRecord | undefined;
  let unsafeFailure = "";
  try {
    unsafeApp = await jelly.service.apps.deploy({
      id: ids[4]!,
      name: ids[4]!,
      sourceDirectory: source,
      executable: process.execPath,
      args: ["binding-probe.ts"],
      test: { executable: process.execPath, args: ["test", "app.test.ts"] },
    });
  } catch (error) {
    unsafeFailure = String(error);
  }
  assert.equal(
    await readFile(
      join(instance, "apps", "data", ids[4]!, "outbound-status.txt"),
      "utf8",
    ),
    "200",
    "Runtime TCP outbound requests must remain supported",
  );
  const probe = JSON.parse(
    await readFile(
      join(instance, "apps", "data", ids[4]!, "bind-probe.json"),
      "utf8",
    ),
  );
  if (unsafeApp) {
    assert.ok(
      probe.denied,
      "Readiness must never succeed with a child TCP listener",
    );
    evidence.descendantBinding = {
      kernelBindDenied: probe.denied,
      outboundHTTP: 200,
    };
    await jelly.service.apps.remove(unsafeApp.id, { uninstall: true });
  } else {
    assert.match(unsafeFailure, /Unsafe runtime isolation/);
    assert.ok(probe.port);
    assert.equal(await adapter.state(ownedName(ids[4]!)), "stopped");
    assert.equal(await adapter.state(ownedName(ids[4]!, true)), "stopped");
    await assert.rejects(
      fetch(`http://127.0.0.1:${probe.port}/api/echo`, {
        signal: AbortSignal.timeout(2000),
      }),
    );
    evidence.descendantBinding = {
      kernelBindDenied: false,
      cgroupDescendantQuarantined: true,
      arbitraryTCPPort: probe.port,
      runtimeAndGatewayStopped: true,
      rawTCPRefusedAfterQuarantine: true,
      outboundHTTP: 200,
    };
  }
  evidence.lifecycle = {
    stopStartRestart: "passed",
    siblingUnaffected: true,
    unregisterContinuesRunning: true,
    uninstallRetainsSourceData: true,
  };
} catch (error) {
  evidence.failure = String(error);
  process.exitCode = 1;
} finally {
  if (evidence.failure && jelly) {
    for (const id of ids) {
      try {
        evidence[id + "Diagnostics"] = await jelly.service.apps.logs(id, 40);
      } catch {}
    }
  }
  try {
    await jelly?.close();
  } catch (error) {
    evidence.temporaryJellyCloseFailure = String(error);
    process.exitCode = 1;
  }
  // Stop/remove only matching exact ownership markers from this script's UUIDs.
  try {
    for (const id of instanceId ? ids : []) {
      const names = [ownedName(id), ownedName(id, true)];
      for (const name of names) {
        const content = await adapter.readUnit(name);
        if (!content) {
          // Failed activation may already have removed a file; remove any owned
          // dangling boot link by exact UUID-derived name (never another app).
          const link = join(
            homedir(),
            ".config/systemd/user/default.target.wants",
            name,
          );
          try {
            const { readlink } = await import("node:fs/promises");
            assert.equal(
              await readlink(link),
              join(homedir(), ".config/systemd/user", name),
            );
            await adapter.systemctl("disable", [name]);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          continue;
        }
        assert.ok(
          content.startsWith(unitOwner(instanceId!, id)),
          "Ownership mismatch: retaining all temp evidence",
        );
        await adapter.systemctl("stop", [name]);
        await adapter.systemctl("disable", [name]);
        await adapter.removeUnit(name);
      }
    }
    await adapter.systemctl("daemon-reload");
    for (const id of instanceId ? ids : []) {
      for (const name of [ownedName(id), ownedName(id, true)])
        assert.equal(await adapter.readUnit(name), null);
      await removeRuntimeSocket(
        runtimeSocketPath({ instanceId: instanceId!, appId: id }),
        { instanceId: instanceId!, appId: id },
      );
    }
    cleanupComplete = true;
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    evidence.cleanupFailure = String(error);
    process.exitCode = 1;
  }
  evidence.ownedCleanupComplete = cleanupComplete;
  console.log(JSON.stringify(evidence, null, 2));
}
