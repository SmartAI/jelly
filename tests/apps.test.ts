import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { AppsService } from "../src/server/apps";
import { appUrl } from "../src/server/apps-validation";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "trusted-apps-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "test.sqlite"));
  cleanups.push(() => store.close());
  const apps = new AppsService(store, {
    dataDir: dir,
    allowedOrigins: ["http://localhost:5173"],
    now: () => new Date("2026-01-01"),
  });
  return { apps, store, dir };
}
test("AppsService registers metadata only, stable slug/id, explicit stars and durable visit intent", () => {
  const { apps, store, dir } = fixture();
  const first = apps.register({
    name: "Money",
    url: "http://localhost:3007/dashboard",
  });
  expect(first.url).toBe("http://localhost:3007/dashboard");
  expect(first.starredAt).toBeNull();
  expect(first.lastOpenedAt).toBeNull();
  const starred = apps.setStarred(first.id, true);
  expect(apps.setStarred(first.id, true).starredAt).toBe(starred.starredAt);
  const launch = apps.recordLaunch(first.id, "entry");
  expect(apps.recordLaunch(first.id, "entry").lastOpenedAt).toBe(
    launch.lastOpenedAt,
  );
  const edited = apps.register({
    slug: first.slug,
    name: "New money",
    url: "https://box.tailfixture.ts.net:3007",
  });
  expect(edited.id).toBe(first.id);
  expect(edited.starredAt).toBe(starred.starredAt);
  expect(edited.lastOpenedAt).toBe(launch.lastOpenedAt);
  apps.register({ id: first.id, name: "Renamed" });
  expect(apps.get(first.id).slug).toBe(first.slug);
  const reopened = new Store(join(dir, "test.sqlite"));
  try {
    expect(new AppsService(reopened, { dataDir: dir }).get(first.id)).toEqual(
      apps.get(first.id),
    );
  } finally {
    reopened.close();
  }
  apps.remove(first.id);
  expect(() => apps.get(first.id)).toThrow("not found");
  expect(
    store.db.query("SELECT COUNT(*) AS n FROM app_launches").get(),
  ).toEqual({ n: 0 });
  const tables = (
    store.db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]
  ).map((row) => row.name);
  expect(
    tables.filter((name) =>
      /^app_(resources|ports|locks|releases)$/.test(name),
    ),
  ).toEqual([]);
});
test("AppsService history pagination, search and preference order are stable", () => {
  const { apps } = fixture();
  const rows = Array.from({ length: 5 }, (_, index) =>
    apps.register({
      name: `Fixture ${index}`,
      url: `http://localhost:${3000 + index}`,
    }),
  );
  apps.setStarred(rows[0]!.id, true);
  apps.setStarred(rows[1]!.id, true);
  apps.recordLaunch(rows[0]!.id, "launch");
  expect(apps.list().starred.map((app) => app.id)).toEqual([
    rows[1]!.id,
    rows[0]!.id,
  ]);
  const page = apps.list({ q: "fixture", limit: 2 });
  expect(page.history).toHaveLength(2);
  expect(page.after).toBeTruthy();
  const next = apps.list({ q: "fixture", limit: 2, after: page.after! });
  expect(next.history.map((app) => app.id)).toEqual([rows[2]!.id]);
  expect(next.after).toBeNull();
  expect(() => apps.list({ q: "other", after: page.after! })).toThrow("cursor");
  expect(() => apps.list({ limit: NaN })).toThrow("Limit");
});
test("App URL accepts HTTP(S) browser paths and same-host ports, rejects credentials/secrets/recursive viewer", () => {
  const origins = [
    "http://localhost:5173",
    "http://box.tailfixture.ts.net:5173",
  ];
  for (const url of [
    "http://localhost:3007",
    "https://box.tailfixture.ts.net:3007/reports",
    "http://100.64.0.1:8000",
    "https://example.test/app",
  ])
    expect(appUrl(url, origins)).toBe(new URL(url).href);
  for (const url of [
    "file:///etc/passwd",
    "data:text/html,hi",
    "javascript:alert(1)",
    "https://user:pass@example.test",
    "https://example.test/?token=secret",
    "https://example.test/#secret",
    "http://localhost:5173/apps/id",
    "http://box.tailfixture.ts.net:5173/%61pps/id",
    "http://localhost:5173/apps",
    "https://example.test/%XX",
  ])
    expect(() => appUrl(url, origins)).toThrow();
  const { apps } = fixture();
  expect(() => apps.register({ name: "Missing URL" })).toThrow();
  expect(() =>
    apps.register({
      name: "Bad metadata",
      url: "http://localhost:3007",
      launchMode: "direct",
    }),
  ).toThrow("Unknown");
  expect(() =>
    apps.register({
      name: "Bad owner",
      url: "http://localhost:3007",
      builderAgentId: "missing",
    }),
  ).toThrow("not found");
});

test("AppsService non-ASCII names do not collide through a default slug", () => {
  const { apps } = fixture();
  const a = apps.register({ name: "📈", url: "http://localhost:3007" });
  const b = apps.register({ name: "📉", url: "http://localhost:3007" });
  expect(a.id).not.toBe(b.id);
  expect(a.slug).not.toBe(b.slug);
  expect(apps.register({ id: a.id, name: "New 📈" }).slug).toBe(a.slug);
});

test("name-only creation never overwrites colliding names or preferences", () => {
  const { apps } = fixture();
  const first = apps.register({
    name: "Budget!",
    url: "http://localhost:3001",
  });
  apps.setStarred(first.id, true);
  apps.recordLaunch(first.id, "first-visit");
  const saved = apps.get(first.id);
  for (const name of ["Budget?", "Budget!", "Budget"]) {
    const added = apps.register({ name, url: "http://localhost:3002" });
    expect(added.id).not.toBe(first.id);
    expect(added.slug).not.toBe(first.slug);
    expect(added.starredAt).toBeNull();
    expect(added.lastOpenedAt).toBeNull();
    expect(apps.get(first.id)).toEqual(saved);
  }
  expect(apps.list().history).toHaveLength(3);
  const edited = apps.register({
    slug: first.slug,
    name: "Explicit update",
    url: "http://localhost:3003",
  });
  expect(edited.id).toBe(first.id);
  expect(edited.starredAt).toBe(saved.starredAt);
  expect(edited.lastOpenedAt).toBe(saved.lastOpenedAt);
});

test("generated slugs accept 100-character names and descriptions allow ordinary lines", () => {
  const { apps } = fixture();
  for (const name of ["a".repeat(81), "a".repeat(100), "a".repeat(100)]) {
    const added = apps.register({
      name,
      url: "http://localhost:3007",
      description: "first\nsecond\r\nthird\tline",
    });
    expect(added.name).toBe(name);
    expect(added.slug.length).toBeLessThanOrEqual(80);
    expect(added.description).toBe("first\nsecond\r\nthird\tline");
  }
  expect(apps.list().history).toHaveLength(3);
  expect(() =>
    apps.register({
      name: "Bad control",
      url: "http://localhost:3007",
      description: "bad\0description",
    }),
  ).toThrow("Description");
});
