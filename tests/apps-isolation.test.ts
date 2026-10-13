import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import {
  runtimeSocketPath,
  verifySocketParent,
  validateRuntimeSocket,
  prepareRuntimeSocket,
} from "../src/server/apps-sockets";
import { cgroupSocketInventory } from "../src/server/apps-isolation";
import { SystemAppsAdapter } from "../src/server/apps-runtime";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-as-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const owner = { instanceId: "socket-fixture", appId: "fixture-app" };
  return { dir, owner, socket: runtimeSocketPath(owner, join(dir, "s")) };
}
test("socket paths are stable, short, instance/app-scoped and reject length/traversal or wrong identity", () => {
  const f = fixture();
  expect(f.socket).toBe(runtimeSocketPath(f.owner, join(f.dir, "s")));
  expect(Buffer.byteLength(f.socket)).toBeLessThanOrEqual(103);
  expect(
    runtimeSocketPath(
      { ...f.owner, instanceId: "other-instance" },
      join(f.dir, "s"),
    ),
  ).not.toBe(f.socket);
  expect(
    runtimeSocketPath({ ...f.owner, appId: "other-app" }, join(f.dir, "s")),
  ).not.toBe(f.socket);
  expect(() => runtimeSocketPath(f.owner, "/tmp/" + "x".repeat(100))).toThrow(
    "103 bytes",
  );
  expect(() => runtimeSocketPath({ ...f.owner, appId: "../foreign" })).toThrow(
    "Invalid",
  );
});
test("socket directories and markers fail closed on world permissions, symlinks and ownership conflicts", async () => {
  const f = fixture();
  const base = join(f.dir, "s");
  mkdirSync(base, { mode: 0o777 });
  chmodSync(base, 0o777);
  await expect(verifySocketParent(f.socket, f.owner, true)).rejects.toThrow(
    "owner-only",
  );
  chmodSync(base, 0o700);
  await verifySocketParent(f.socket, f.owner, true);
  const marker = join(dirname(f.socket), "owner.json");
  writeFileSync(
    marker,
    JSON.stringify({ ...f.owner, instanceId: "foreign-instance" }),
  );
  await expect(verifySocketParent(f.socket, f.owner)).rejects.toThrow(
    "conflict",
  );
  const target = join(f.dir, "private-fixture.json");
  writeFileSync(target, "unchanged fixture");
  rmSync(marker);
  symlinkSync(target, marker);
  await expect(verifySocketParent(f.socket, f.owner)).rejects.toThrow("marker");
  expect(readFileSync(target, "utf8")).toBe("unchanged fixture");
  rmSync(base, { recursive: true });
  symlinkSync(f.dir, base);
  await expect(verifySocketParent(f.socket, f.owner, true)).rejects.toThrow(
    "canonical",
  );
});
test("socket preparation never follows/deletes regular files or socket symlinks", async () => {
  const f = fixture();
  await verifySocketParent(f.socket, f.owner, true);
  expect(await validateRuntimeSocket(f.socket, f.owner)).toBe(false);
  writeFileSync(f.socket, "retain this regular file");
  await expect(prepareRuntimeSocket(f.socket, f.owner)).rejects.toThrow(
    "owned socket",
  );
  expect(readFileSync(f.socket, "utf8")).toBe("retain this regular file");
  const target = join(f.dir, "target.sock");
  writeFileSync(target, "untouched");
  rmSync(f.socket);
  symlinkSync(target, f.socket);
  await expect(prepareRuntimeSocket(f.socket, f.owner)).rejects.toThrow(
    "owned socket",
  );
  expect(readFileSync(target, "utf8")).toBe("untouched");
});
test("owned socket validation tolerates unavailable leaf realpath but still refuses socket symlinks", async () => {
  const f = fixture();
  await verifySocketParent(f.socket, f.owner, true);
  const original = fsPromises.realpath;
  const leafUnsupported = spyOn(fsPromises, "realpath").mockImplementation(
    (async (path: any, options: any) => {
      if (path === f.socket)
        throw Object.assign(new Error("socket realpath unsupported"), {
          code: "EOPNOTSUPP",
        });
      return original(path, options);
    }) as typeof fsPromises.realpath,
  );
  const server = Bun.serve({
    unix: f.socket,
    fetch: () => new Response("fixture"),
  });
  try {
    expect(await validateRuntimeSocket(f.socket, f.owner)).toBe(true);
    expect(leafUnsupported.mock.calls.some(([path]) => path === f.socket)).toBe(
      false,
    );
  } finally {
    leafUnsupported.mockRestore();
    server.stop(true);
  }
  if (existsSync(f.socket)) rmSync(f.socket);
  const target = join(f.dir, "target.sock");
  const other = Bun.serve({
    unix: target,
    fetch: () => new Response("untouched"),
  });
  try {
    symlinkSync(target, f.socket);
    await expect(validateRuntimeSocket(f.socket, f.owner)).rejects.toThrow(
      "owned socket",
    );
    await expect(prepareRuntimeSocket(f.socket, f.owner)).rejects.toThrow(
      "owned socket",
    );
    expect(existsSync(target)).toBe(true);
  } finally {
    other.stop(true);
  }
});
test("exact Unix socket health works with Bun and Node HTTP APIs, never follows redirects", async () => {
  const f = fixture();
  await verifySocketParent(f.socket, f.owner, true);
  const adapter = new SystemAppsAdapter();
  const bun = Bun.serve({
    unix: f.socket,
    fetch: (request) =>
      new URL(request.url).pathname === "/health"
        ? Response.json({ ok: true })
        : Response.redirect("http://127.0.0.1:1/health", 302),
  });
  cleanups.push(() => bun.stop(true));
  expect(await validateRuntimeSocket(f.socket, f.owner)).toBe(true);
  expect(await adapter.socketHealth(f.socket, "/health")).toBe(true);
  expect(await adapter.socketHealth(f.socket, "/redirect")).toBe(false);
  expect(await adapter.socketHealth(f.socket + ".absent", "/health")).toBe(
    false,
  );
  bun.stop(true);
  if (existsSync(f.socket)) await prepareRuntimeSocket(f.socket, f.owner);
  const node = createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 503);
    response.end("ok");
  });
  await new Promise<void>((resolve) => node.listen(f.socket, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        node.closeAllConnections();
        node.close(() => resolve());
      }),
  );
  expect(await adapter.socketHealth(f.socket, "/health")).toBe(true);
  expect(await adapter.socketHealth(f.socket, "/unhealthy")).toBe(false);
});
test("cgroup inventory detects arbitrary IPv4/IPv6 descendant TCP listeners but not foreign units or outbound sockets", async () => {
  const f = fixture();
  const cgroup = join(f.dir, "cgroup"),
    proc = join(f.dir, "proc");
  mkdirSync(join(cgroup, "owned", "descendant"), { recursive: true });
  writeFileSync(join(cgroup, "owned", "cgroup.procs"), "101\n");
  writeFileSync(join(cgroup, "owned", "descendant", "cgroup.procs"), "102\n");
  for (const pid of [101, 102, 999])
    mkdirSync(join(proc, String(pid), "fd"), { recursive: true });
  for (const [pid, fd, inode] of [
    [101, 1, 501],
    [102, 2, 502],
    [102, 3, 503],
    [101, 4, 701],
    [999, 5, 999],
  ])
    symlinkSync(`socket:[${inode}]`, join(proc, String(pid), "fd", String(fd)));
  mkdirSync(join(proc, "net"));
  const tcp = (address: string, state: string, inode: number) =>
    `0: ${address} remote ${state} tx rx timer uid 0 ${inode}`;
  writeFileSync(
    join(proc, "net", "tcp"),
    "header\n" +
      [
        tcp("0100007F:C123", "0A", 501),
        tcp("0100007F:C124", "01", 503),
        tcp("0100007F:C125", "0A", 999),
      ].join("\n"),
  );
  writeFileSync(
    join(proc, "net", "tcp6"),
    "header\n" + tcp("00000000000000000000000000000000:C126", "0A", 502),
  );
  writeFileSync(
    join(proc, "net", "unix"),
    `header\n000: 2 0 00010000 0001 01 701 ${f.socket}`,
  );
  expect(await cgroupSocketInventory("/owned", { cgroup, proc })).toEqual({
    tcpListeners: ["0100007F:C123", "00000000000000000000000000000000:C126"],
    unixListeners: [f.socket],
  });
  await expect(
    cgroupSocketInventory("/../foreign", { cgroup, proc }),
  ).rejects.toThrow("Invalid");
});

test("template accepts the complete production-generated loopback/DNS/bare-hostname/Tailscale IPv4/IPv6 origin set", async () => {
  const { tailscaleOrigins } = await import("../scripts/tailscale");
  const f = fixture();
  await verifySocketParent(f.socket, f.owner, true);
  const { createApp } = await import("../templates/apps/server");
  const environment = {
    HOST: "127.0.0.1",
    PORT: "0",
    APP_SOCKET: f.socket,
    APP_DATA_DIR: f.dir,
    JELLY_APP_ID: f.owner.appId,
  };
  const network = tailscaleOrigins(
    {
      BackendState: "Running",
      TailscaleIPs: ["100.65.93.87", "fd7a:115c:a1e0::f439:5d58"],
      Self: { DNSName: "box.tailbfab3f.ts.net.", HostName: "box" },
    },
    5173,
  );
  const origins = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://[::1]:5173",
    ...network.origins,
  ];
  const app = createApp({
    ...environment,
    JELLY_ALLOWED_ORIGINS: JSON.stringify(origins),
  });
  const config = await app
    .fetch(new Request("http://app/jelly-config.json"))
    .json();
  expect(config.allowedOrigins).toEqual(origins);
  for (const origin of origins)
    expect(
      app
        .fetch(new Request("http://app/health"))
        .headers.get("content-security-policy"),
    ).toContain(origin);
  for (const origin of [
    "http://192.168.1.1:5173",
    "http://8.8.8.8:5173",
    "https://public.example.com",
    "http://100.63.0.1:5173",
  ])
    expect(() =>
      createApp({
        ...environment,
        JELLY_ALLOWED_ORIGINS: JSON.stringify([origin]),
      }),
    ).toThrow();
});

test("exiting proc/fd races do not quarantine ordinary failures; inaccessible live processes still fail closed", async () => {
  const f = fixture(),
    cgroup = join(f.dir, "cgroup"),
    proc = join(f.dir, "proc");
  mkdirSync(join(cgroup, "owned"), { recursive: true });
  writeFileSync(join(cgroup, "owned", "cgroup.procs"), "101\n");
  const fd = join(proc, "101", "fd");
  mkdirSync(fd, { recursive: true });
  mkdirSync(join(proc, "net"));
  for (const table of ["tcp", "tcp6", "unix"])
    writeFileSync(join(proc, "net", table), "header\n");
  chmodSync(fd, 0o000);
  try {
    writeFileSync(
      join(proc, "101", "stat"),
      "101 (exiting child) R 0 0 0 0 0 4",
    );
    expect(await cgroupSocketInventory("/owned", { cgroup, proc })).toEqual({
      tcpListeners: [],
      unixListeners: [],
    });
    writeFileSync(join(proc, "101", "stat"), "101 (live child) R 0 0 0 0 0 0");
    await expect(
      cgroupSocketInventory("/owned", { cgroup, proc }),
    ).rejects.toThrow();
  } finally {
    chmodSync(fd, 0o700);
  }
});
