import { mkdir, writeFile, unlink } from "node:fs/promises";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import {
  appsCapabilities,
  type AppRecord,
  type AppsPage,
  type AppsCapabilities,
} from "../shared/apps";
import { Store } from "./store";
import { HttpError } from "./errors";
import {
  appIconMime,
  APP_ICON_EXTENSIONS,
  type AppIconMime,
} from "./apps-icons";
import { appId, appSlug, appText, appCorner, appUrl } from "./apps-validation";

export interface AppsOptions {
  dataDir: string;
  allowedOrigins?: string[];
  emit?: (type: string, data: Record<string, unknown>) => void;
  now?: () => Date;
}
export class AppsService {
  private readonly root: string;
  private allowedOrigins: string[];
  private timestamp = 0;
  constructor(
    readonly store: Store,
    readonly options: AppsOptions,
  ) {
    this.root = join(resolve(options.dataDir), "apps");
    this.allowedOrigins = options.allowedOrigins ?? [];
    this.timestamp = this.rows().reduce(
      (latest, app) => Math.max(latest, Date.parse(app.updatedAt) || 0),
      0,
    );
  }
  configureOrigins(origins: string[]) {
    this.allowedOrigins = [...new Set(origins)];
  }
  private now() {
    this.timestamp = Math.max(
      (this.options.now?.() ?? new Date()).getTime(),
      this.timestamp + 1,
    );
    return new Date(this.timestamp).toISOString();
  }
  private rows(): AppRecord[] {
    return (
      this.store.db.query("SELECT record FROM apps").all() as {
        record: string;
      }[]
    ).map((row) => JSON.parse(row.record));
  }
  get(id: string): AppRecord {
    appId(id);
    const row = this.store.db
      .query("SELECT record FROM apps WHERE id=?")
      .get(id) as { record: string } | null;
    if (!row) throw new HttpError(404, "App not found.");
    return JSON.parse(row.record);
  }
  private save(record: AppRecord) {
    this.store.db
      .query(
        "INSERT INTO apps(id,slug,record) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,record=excluded.record",
      )
      .run(record.id, record.slug, JSON.stringify(record));
    return record;
  }
  private changed(app: AppRecord) {
    this.options.emit?.("apps_changed", { app });
    return app;
  }
  list(query: { q?: string; after?: string; limit?: number } = {}): AppsPage {
    const q =
      query.q === undefined
        ? ""
        : appText(query.q, "Search", 200, true).toLocaleLowerCase();
    const limit = query.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, "Limit must be an integer from 1 to 100.");
    let cursor: { q: string; at: string; id: string } | undefined;
    if (query.after) {
      try {
        if (query.after.length > 2000) throw new Error();
        const data = JSON.parse(
          Buffer.from(query.after, "base64url").toString(),
        );
        if (
          data.v !== 1 ||
          data.q !== q ||
          typeof data.at !== "string" ||
          !/^\d{4}-\d\d-\d\dT/.test(data.at) ||
          typeof data.id !== "string"
        )
          throw new Error();
        appId(data.id);
        cursor = data;
      } catch {
        throw new HttpError(
          400,
          "Invalid Apps history cursor; restart this search.",
        );
      }
    }
    const rows = this.rows().filter(
      (app) =>
        !q ||
        [app.name, app.slug, app.description].some((value) =>
          value.toLocaleLowerCase().includes(q),
        ),
    );
    const order = (left: string, right: string, a: string, b: string) =>
      left === right ? (a < b ? -1 : a > b ? 1 : 0) : left > right ? -1 : 1;
    const starred = rows
      .filter((app) => app.starredAt)
      .sort((a, b) => order(a.starredAt!, b.starredAt!, a.id, b.id));
    const at = (app: AppRecord) => app.lastOpenedAt ?? app.createdAt;
    const history = rows
      .filter(
        (app) =>
          !app.starredAt &&
          (!cursor ||
            at(app) < cursor.at ||
            (at(app) === cursor.at && app.id > cursor.id)),
      )
      .sort((a, b) => order(at(a), at(b), a.id, b.id));
    const page = history.slice(0, limit);
    const last = page.at(-1);
    return {
      starred,
      history: page,
      after:
        history.length > limit && last
          ? Buffer.from(
              JSON.stringify({ v: 1, q, at: at(last), id: last.id }),
            ).toString("base64url")
          : null,
      capabilities: appsCapabilities(),
    };
  }
  register(
    input: Record<string, unknown>,
    defaults?: { builderAgentId: string; projectId: string | null },
  ): AppRecord {
    const fields = new Set([
      "id",
      "slug",
      "name",
      "url",
      "description",
      "iconAssetId",
      "projectId",
      "builderAgentId",
      "sourceDirectory",
      "viewerCorner",
    ]);
    for (const field of Object.keys(input))
      if (!fields.has(field))
        throw new HttpError(400, `Unknown app metadata field: ${field}.`);
    const app = this.store.db.transaction(() => {
      const namedId = input.id === undefined ? undefined : appId(input.id);
      const prior = namedId ? this.find(namedId) : undefined;
      const name = appText(input.name ?? prior?.name, "Name", 100);
      let slug = appSlug(
        input.slug ??
          prior?.slug ??
          (name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 80)
            .replace(/^-|-$/g, "") ||
            `app-${crypto.randomUUID().slice(0, 8)}`),
      );
      // Name-only registration creates a new app, never implicitly edits one.
      // Only an explicit ID or slug identifies an existing registration.
      if (input.slug === undefined && !prior) {
        const base = slug;
        let suffix = 1;
        while (
          this.store.db.query("SELECT id FROM apps WHERE slug=?").get(slug)
        ) {
          const ending = `-${++suffix}`;
          slug = base.slice(0, 80 - ending.length).replace(/-$/, "") + ending;
        }
      }
      const bySlug = this.store.db
        .query("SELECT id FROM apps WHERE slug=?")
        .get(slug) as { id: string } | null;
      const id =
        namedId ??
        (input.slug === undefined ? undefined : bySlug?.id) ??
        crypto.randomUUID();
      const existing = this.find(id);
      if (bySlug && bySlug.id !== id)
        throw new HttpError(409, "Another app already uses that slug.");
      const metadata = existing
        ? input
        : {
            ...defaults,
            ...Object.fromEntries(
              Object.entries(input).filter(([, value]) => value !== undefined),
            ),
          };
      for (const [field, getter] of [
        ["projectId", (id: string) => this.store.project(id)],
        ["builderAgentId", (id: string) => this.store.agent(id)],
      ] as const)
        if (metadata[field] != null && !getter(appId(metadata[field])))
          throw new HttpError(404, `${field} not found.`);
      const nullable = (field: "projectId" | "builderAgentId") =>
        metadata[field] === undefined
          ? (existing?.[field] ?? null)
          : metadata[field] === null
            ? null
            : appId(metadata[field]);
      const source =
        metadata.sourceDirectory === undefined
          ? (existing?.sourceDirectory ?? null)
          : metadata.sourceDirectory === null
            ? null
            : appText(metadata.sourceDirectory, "Source directory", 4096);
      if (source && !isAbsolute(source))
        throw new HttpError(400, "Source directory must be absolute.");
      const iconAssetId =
        input.iconAssetId === undefined
          ? (existing?.iconAssetId ?? null)
          : input.iconAssetId === null
            ? null
            : appId(input.iconAssetId);
      if (iconAssetId) {
        try {
          this.ownedIcon(id, iconAssetId);
        } catch {
          throw new HttpError(
            400,
            "iconAssetId must reference a valid raster asset owned by this app.",
          );
        }
      }
      const now = this.now();
      return this.save({
        id,
        slug,
        name,
        url: appUrl(input.url ?? existing?.url, this.allowedOrigins),
        description:
          input.description === undefined
            ? (existing?.description ?? "")
            : appText(input.description, "Description", 4000, true, true),
        iconAssetId,
        projectId: nullable("projectId"),
        builderAgentId: nullable("builderAgentId"),
        sourceDirectory: source,
        starredAt: existing?.starredAt ?? null,
        lastOpenedAt: existing?.lastOpenedAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        viewerCorner:
          input.viewerCorner === undefined
            ? (existing?.viewerCorner ?? "top-left")
            : appCorner(input.viewerCorner),
      });
    })();
    return this.changed(app);
  }
  private find(id: string): AppRecord | undefined {
    const row = this.store.db
      .query("SELECT record FROM apps WHERE id=?")
      .get(id) as { record: string } | null;
    return row ? JSON.parse(row.record) : undefined;
  }
  private ownedIcon(
    id: string,
    assetId: string,
  ): { bytes: Uint8Array; contentType: AppIconMime } {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        assetId,
      )
    )
      throw new HttpError(404, "App icon not found.");
    const asset = this.store.db
      .query("SELECT mime FROM app_icon_assets WHERE id=? AND appId=?")
      .get(assetId, id) as { mime: AppIconMime } | null;
    if (!asset || !Object.hasOwn(APP_ICON_EXTENSIONS, asset.mime))
      throw new HttpError(404, "App icon not found.");
    const filename = `${assetId}.${APP_ICON_EXTENSIONS[asset.mime]}`;
    const directory = join(this.root, "icons");
    const path = join(directory, filename);
    try {
      if (
        !lstatSync(directory).isDirectory() ||
        realpathSync(directory) !== join(realpathSync(this.root), "icons") ||
        !lstatSync(path).isFile() ||
        realpathSync(path) !== join(realpathSync(directory), filename)
      )
        throw new Error();
      const bytes = readFileSync(path);
      appIconMime(bytes, asset.mime);
      return { bytes, contentType: asset.mime };
    } catch {
      throw new HttpError(404, "App icon not found or invalid.");
    }
  }
  icon(id: string) {
    const app = this.get(id);
    if (!app.iconAssetId) throw new HttpError(404, "App icon not found.");
    return this.ownedIcon(id, app.iconAssetId);
  }
  async setIcon(
    id: string,
    input: { bytes: Uint8Array; contentType: string },
  ): Promise<AppRecord> {
    const mime = appIconMime(input.bytes, input.contentType);
    appId(id);
    this.get(id);
    const assetId = crypto.randomUUID();
    const directory = join(this.root, "icons");
    const path = join(directory, `${assetId}.${APP_ICON_EXTENSIONS[mime]}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      !lstatSync(directory).isDirectory() ||
      realpathSync(directory) !== join(realpathSync(this.root), "icons")
    )
      throw new HttpError(
        409,
        "App icon storage must be the canonical instance-owned directory.",
      );
    await writeFile(path, input.bytes, { mode: 0o600, flag: "wx" });
    let record: AppRecord;
    try {
      record = this.store.db.transaction(() => {
        this.store.db
          .query("INSERT INTO app_icon_assets(id,appId,mime) VALUES (?,?,?)")
          .run(assetId, id, mime);
        return this.save({
          ...this.get(id),
          iconAssetId: assetId,
          updatedAt: this.now(),
        });
      })();
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
    return this.changed(record);
  }
  setStarred(id: string, starred: boolean) {
    if (typeof starred !== "boolean")
      throw new HttpError(400, "starred must be a boolean.");
    const result = this.store.db.transaction(() => {
      const app = this.get(id);
      if (!!app.starredAt === starred) return app;
      const now = this.now();
      return this.save({
        ...app,
        starredAt: starred ? now : null,
        updatedAt: now,
      });
    })();
    return this.changed(result);
  }
  recordLaunch(id: string, navigationId: string) {
    navigationId = appText(navigationId, "Navigation ID", 128);
    const app = this.store.db.transaction(() => {
      const existing = this.get(id);
      const now = this.now();
      const insert = this.store.db
        .query(
          "INSERT OR IGNORE INTO app_launches(appId,navigationId,createdAt) VALUES (?,?,?)",
        )
        .run(id, navigationId, now);
      if (!insert.changes) return existing;
      // Durable deduplication is deliberately not evicted by other visits.
      return this.save({ ...existing, lastOpenedAt: now, updatedAt: now });
    })();
    return this.changed(app);
  }
  async capabilities(): Promise<AppsCapabilities> {
    return appsCapabilities();
  }
  remove(id: string) {
    this.get(id);
    this.store.db.query("DELETE FROM apps WHERE id=?").run(id);
    this.options.emit?.("apps_changed", { removedId: id });
    return { ok: true };
  }
}
