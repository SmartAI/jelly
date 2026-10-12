import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "./server";
import { validRoute } from "./jelly-bridge.mjs";

const directories: string[] = [];
const servers: Bun.Server<undefined>[] = [];
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true));
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-template-"));
  directories.push(dir);
  const environment = {
    HOST: "127.0.0.1",
    PORT: "0",
    APP_SOCKET: join(dir, "http.sock"),
    APP_DATA_DIR: dir,
    JELLY_APP_ID: "test-app",
    JELLY_ALLOWED_ORIGINS: JSON.stringify([
      "http://127.0.0.1:5173",
      "http://fixture.tailtest.ts.net:5173",
    ]),
  };
  return { dir, environment, app: createApp(environment) };
}
test("production health, allowlisted framing and persistent storage survive a new app instance", async () => {
  const { dir, environment, app } = fixture();
  expect(app.unix).toBe(environment.APP_SOCKET);
  const health = app.fetch(new Request("http://127.0.0.1:12345/health"));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  expect(health.headers.get("content-security-policy")).toContain(
    "frame-ancestors http://127.0.0.1:5173 http://fixture.tailtest.ts.net:5173",
  );
  writeFileSync(
    join(dir, "note.json"),
    JSON.stringify({ title: "Retained", body: "Data survives a release" }),
  );
  const again = createApp(environment);
  expect(
    await again.fetch(new Request("http://127.0.0.1:12345/note.json")).json(),
  ).toEqual({ title: "Retained", body: "Data survives a release" });
  expect(readFileSync(join(dir, "note.json"), "utf8")).toContain("Retained");
});
test("production server serves health and fixed resources on a disposable Unix socket", async () => {
  const { app } = fixture();
  const server = Bun.serve(app); // Test-only ephemeral port, never the live runtime/gateway.
  servers.push(server);
  const origin = "http://localhost";
  const socketFetch = (url: string) => fetch(url, { unix: app.unix });
  expect(await (await socketFetch(`${origin}/health`)).json()).toEqual({
    ok: true,
  });
  const page = await socketFetch(`${origin}/notes`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('id="jelly-home"');
  const config = await (
    await socketFetch(`${origin}/jelly-config.json`)
  ).json();
  expect(config).toEqual({
    appId: "test-app",
    allowedOrigins: [
      "http://127.0.0.1:5173",
      "http://fixture.tailtest.ts.net:5173",
    ],
    corner: "top-left",
  });
  expect((await socketFetch(`${origin}/server.ts`)).status).toBe(404);
});
test("symlinked app data is rejected without reading or overwriting its target", () => {
  const { dir, environment, app } = fixture();
  const target = join(dir, "private.json");
  writeFileSync(
    target,
    JSON.stringify({ title: "Private", body: "Do not expose" }),
  );
  rmSync(join(dir, "note.json"));
  symlinkSync(target, join(dir, "note.json"));
  expect(
    app.fetch(new Request("http://127.0.0.1:12345/note.json")).status,
  ).toBe(503);
  expect(() => createApp(environment)).toThrow();
  expect(readFileSync(target, "utf8")).toContain("Private");
});
test("invalid runtime configuration and corrupted data fail closed", () => {
  const { dir, environment, app } = fixture();
  for (const input of [
    { HOST: "0.0.0.0" },
    { PORT: "123; shell" },
    { APP_SOCKET: "relative.sock" },
    { APP_SOCKET: "/tmp/" + "x".repeat(110) },
    { APP_DATA_DIR: "relative" },
    { APP_DATA_DIR: resolve(import.meta.dir, "runtime-data") },
    { APP_DATA_DIR: resolve(import.meta.dir, "..data") },
    { JELLY_APP_ID: "" },
    { JELLY_ALLOWED_ORIGINS: "https://evil.example" },
    { JELLY_ALLOWED_ORIGINS: "http://127.0.0.1:5173/apps" },
  ])
    expect(() => createApp({ ...environment, ...input })).toThrow();
  writeFileSync(join(dir, "note.json"), "corrupt");
  expect(app.fetch(new Request("http://127.0.0.1:12345/health")).status).toBe(
    503,
  );
  expect(() => createApp(environment)).toThrow();
});
test("unknown paths and writes cannot access arbitrary files or modify storage", () => {
  const { app } = fixture();
  expect(
    app.fetch(new Request("http://127.0.0.1:12345/secret.env")).status,
  ).toBe(404);
  expect(
    app.fetch(
      new Request("http://127.0.0.1:12345/note.json", {
        method: "POST",
        body: "replace",
      }),
    ).status,
  ).toBe(405);
  expect(
    app.fetch(new Request("http://127.0.0.1:12345/health", { method: "HEAD" }))
      .body,
  ).toBeNull();
});
test("bridge route contract rejects token-bearing and encoded/unsafe destinations", () => {
  for (const route of ["/", "/notes", "/notes/2026-10"])
    expect(validRoute(route)).toBe(true);
  for (const route of [
    "//evil.example",
    "https://evil.example",
    "/notes?token=secret",
    "/notes#secret",
    "/../secret",
    "/./notes",
    "/%2e%2e/secret",
    "/%2fsecret",
    "/a\\b",
    "/a\n",
    "/" + "x".repeat(2048),
  ])
    expect(validRoute(route)).toBe(false);
});
