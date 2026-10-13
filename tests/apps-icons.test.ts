import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { Store } from "../src/server/store";
import { AppsService } from "../src/server/apps";
import { appIconMime, APP_ICON_MAX_BYTES } from "../src/server/apps-icons";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=",
  "base64",
);
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-app-icons-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "temporary.sqlite"));
  cleanups.push(() => store.close());
  const apps = new AppsService(store, { dataDir: dir });
  return { dir, store, apps };
}
test("icons are generated, app-owned, private raster assets preserving stars and visits", async () => {
  const f = fixture();
  const app = f.apps.register({
    name: "Icon app",
    url: "http://localhost:3007",
  });
  f.apps.setStarred(app.id, true);
  f.apps.recordLaunch(app.id, "opened");
  const before = f.apps.get(app.id);
  expect(() => f.apps.icon(app.id)).toThrow("not found");
  const updated = await f.apps.setIcon(app.id, {
    bytes: png,
    contentType: "image/png",
  });
  expect(updated.iconAssetId).toMatch(/^[a-f0-9-]{36}$/);
  expect(updated.starredAt).toBe(before.starredAt);
  expect(updated.lastOpenedAt).toBe(before.lastOpenedAt);
  expect(f.apps.icon(app.id)).toEqual({ bytes: png, contentType: "image/png" });
  expect(
    statSync(join(f.dir, "apps/icons", `${updated.iconAssetId}.png`)).mode &
      0o077,
  ).toBe(0);
  const other = f.apps.register({
    name: "Other",
    url: "http://localhost:3007",
  });
  expect(() =>
    f.apps.register({
      id: other.id,
      name: other.name,
      iconAssetId: updated.iconAssetId,
    }),
  ).toThrow("owned");
  expect(() =>
    f.apps.register({
      id: app.id,
      name: app.name,
      iconAssetId: "../../secret",
    }),
  ).toThrow();
  expect(() =>
    f.apps.register({
      id: app.id,
      name: app.name,
      iconAssetId: crypto.randomUUID(),
    }),
  ).toThrow("owned");
  expect(
    f.apps.register({
      id: app.id,
      name: "Renamed",
      iconAssetId: updated.iconAssetId,
    }).iconAssetId,
  ).toBe(updated.iconAssetId);
  const reopened = new Store(join(f.dir, "temporary.sqlite"));
  try {
    const apps = new AppsService(reopened, {
      dataDir: f.dir,
    });
    expect(apps.icon(app.id).bytes).toEqual(png);
  } finally {
    reopened.close();
  }
  const another = await f.apps.setIcon(app.id, {
    bytes: png,
    contentType: "image/png",
  });
  expect(another.iconAssetId).not.toBe(updated.iconAssetId);
  f.apps.register({ id: app.id, name: app.name, iconAssetId: null });
  expect(() => f.apps.icon(app.id)).toThrow("not found");
});
test("icons reject malformed/mismatched/oversized/SVG assets and canonical path escapes", async () => {
  const f = fixture();
  const app = f.apps.register({
    name: "Bad icon",
    url: "http://localhost:3007",
  });
  await expect(
    f.apps.setIcon(app.id, { bytes: png, contentType: "image/jpeg" }),
  ).rejects.toThrow("Content-Type");
  await expect(
    f.apps.setIcon(app.id, {
      bytes: Buffer.from("<svg><script>alert(1)</script></svg>"),
      contentType: "image/png",
    }),
  ).rejects.toThrow("valid");
  await expect(
    f.apps.setIcon(app.id, {
      bytes: new Uint8Array(APP_ICON_MAX_BYTES + 1),
      contentType: "image/png",
    }),
  ).rejects.toThrow("1 MiB");
  expect(() => appIconMime(png.subarray(0, 33), "image/png")).toThrow("valid");
  const bomb = Buffer.from(png);
  bomb.writeUInt32BE(100000, 16);
  expect(() => appIconMime(bomb, "image/png")).toThrow("dimensions");
  const updated = await f.apps.setIcon(app.id, {
    bytes: png,
    contentType: "image/png",
  });
  const asset = join(f.dir, "apps/icons", `${updated.iconAssetId}.png`);
  unlinkSync(asset);
  const secret = join(f.dir, "private.png");
  writeFileSync(secret, png);
  symlinkSync(secret, asset);
  expect(() => f.apps.icon(app.id)).toThrow("invalid");
  expect(() => f.apps.register({ id: app.id, name: app.name })).toThrow(
    "owned",
  );
  expect(
    f.store.db.query("SELECT COUNT(*) AS count FROM app_icon_assets").get(),
  ).toEqual({ count: 1 });
});
test("native browser-generated PNG/JPEG/WebP raster formats validate and round-trip", async () => {
  const f = fixture();
  const app = f.apps.register({
    name: "Raster formats",
    url: "http://localhost:3007",
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  const images = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
    return (["image/png", "image/jpeg", "image/webp"] as const).map((mime) => ({
      mime,
      encoded: canvas.toDataURL(mime).split(",")[1]!,
    }));
  });
  for (const image of images) {
    const bytes = Buffer.from(image.encoded, "base64");
    expect(appIconMime(bytes, image.mime)).toBe(image.mime);
    await f.apps.setIcon(app.id, { bytes, contentType: image.mime });
    expect(f.apps.icon(app.id).bytes).toEqual(bytes);
    expect(f.apps.icon(app.id).contentType).toBe(image.mime);
  }
}, 15000);
