import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  stat,
  rename,
  unlink,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import type {
  AppRecord,
  AppsPage,
  AppsCapabilities,
  AppManifest,
  AppObservation,
} from "../shared/apps";
import { Store } from "./store";
import { HttpError } from "./errors";
import {
  appIconMime,
  APP_ICON_EXTENSIONS,
  type AppIconMime,
} from "./apps-icons";
import {
  appId,
  appSlug,
  appText,
  appCorner,
  linkedOrigin,
  validateManifest,
  redactAppDiagnostics,
} from "./apps-validation";
import {
  SystemAppsAdapter,
  defaultAppsCapabilities,
  unitName,
  unitOwner,
  appUnit,
  type AppsAdapter,
} from "./apps-runtime";
import {
  runtimeSocketPath,
  verifySocketParent,
  removeRuntimeSocket,
} from "./apps-sockets";

export interface AppsOptions {
  dataDir: string;
  allowedOrigins?: string[];
  emit?: (type: string, data: Record<string, unknown>) => void;
  adapter?: AppsAdapter;
  appsAdapter?: AppsAdapter;
  now?: () => Date;
  portMin?: number;
  portMax?: number;
  healthAttempts?: number;
  healthDelayMs?: number;
  observationIntervalMs?: number;
  socketBaseDir?: string;
}
interface Resources {
  appId: string;
  unitName: string;
  runtimeSocket: string | null;
  gatewayPort: number;
}
interface Release {
  directory: string;
  runtimeUnit: string;
  gatewayUnit: string;
  manifest: AppManifest;
  app: AppRecord;
}
const unknownObservation = (): AppObservation => ({
  serviceState: "unknown",
  httpHealthy: null,
  checkedAt: null,
  tailnetReachable: null,
  lastError: null,
});
const launcher = `// Persistent app launcher; force the private Unix socket/storage after EnvironmentFile.\nimport { readFile } from 'node:fs/promises';\nimport { prepareRuntimeSocket } from './app-sockets.mjs';\nconst config = JSON.parse(await readFile(process.argv[2], 'utf8'));\nawait prepareRuntimeSocket(config.runtimeSocket,{instanceId:config.instanceId,appId:config.appId});\nconst child = Bun.spawn([config.executable, ...config.args], {cwd:config.cwd,env:{...process.env,HOST:'127.0.0.1',PORT:'0',APP_SOCKET:config.runtimeSocket,APP_DATA_DIR:config.dataDir,JELLY_APP_ID:config.appId,JELLY_ALLOWED_ORIGINS:JSON.stringify(config.allowedOrigins),JELLY_VIEWER_CORNER:config.viewerCorner},stdin:'ignore',stdout:'inherit',stderr:'inherit'});\nlet stopping=false;\nfor (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{stopping=true;child.kill(signal);});\nconst code=await child.exited;\nprocess.exit(stopping?0:code);\n`;

class UnsafeRuntimeError extends HttpError {}

export class AppsService {
  readonly adapter: AppsAdapter;
  private readonly root: string;
  private readonly instanceId: string;
  private allowedOrigins: string[];
  private readonly owner = `${process.pid}-${crypto.randomUUID()}`;
  private cachedCapabilities = defaultAppsCapabilities();
  private timestamp = 0;
  private closed = false;
  private active = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | undefined;
  constructor(
    readonly store: Store,
    readonly options: AppsOptions,
  ) {
    this.root = join(resolve(options.dataDir), "apps");
    this.instanceId = store.instance().id;
    for (const saved of this.rows()) {
      const { runtimePort: _legacyPort, ...record } = saved as AppRecord & {
        runtimePort?: number;
      };
      const app = { ...record, runtimeSocket: record.runtimeSocket ?? null };
      this.save(app);
      if (
        app.managementMode === "managed" &&
        app.unitName &&
        app.unitName !== this.unit(app.id)
      ) {
        this.save({
          ...app,
          runtimeSocket: null,
          localOrigin: null,
          tailnetOrigin: null,
          observation: {
            ...app.observation,
            httpHealthy: false,
            lastError:
              "Legacy ID-only units are not adopted. Operator cleanup and a new deployment are required; Apps will not control these units.",
          },
        });
      }
    }
    this.allowedOrigins = [...new Set(options.allowedOrigins ?? [])];
    this.adapter =
      options.appsAdapter ?? options.adapter ?? new SystemAppsAdapter();
    this.timestamp = this.rows().reduce(
      (latest, app) =>
        Math.max(
          latest,
          Date.parse(app.updatedAt) || 0,
          Date.parse(app.starredAt ?? "") || 0,
          Date.parse(app.lastOpenedAt ?? "") || 0,
        ),
      0,
    );
    for (const app of this.rows()) {
      if (app.desiredState !== "deploying") continue;
      const lock = this.store.db
        .query("SELECT owner,expiresAt FROM app_locks WHERE appId=?")
        .get(app.id) as { owner: string; expiresAt: number } | null;
      let live = false;
      if (lock && lock.expiresAt > Date.now()) {
        try {
          process.kill(Number(lock.owner.split("-")[0]), 0);
          live = true;
        } catch {
          /* Dead Jelly process: its release transaction was interrupted. */
        }
      }
      if (live) continue;
      this.store.db.query("DELETE FROM app_locks WHERE appId=?").run(app.id);
      this.save({
        ...app,
        desiredState: app.deploymentRevision ? "ready" : "draft",
        observation: {
          ...app.observation,
          serviceState: "unknown",
          httpHealthy: null,
          lastError:
            "Deployment was interrupted. Last-good release is retained; inspect logs and retry deployment.",
        },
        updatedAt: this.now(),
      });
    }
    const interval = options.observationIntervalMs ?? 30000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        if (!this.closed && !this.refreshing)
          this.refreshing = this.refresh()
            .catch(() => {})
            .finally(() => {
              this.refreshing = undefined;
            });
      }, interval);
      this.timer.unref();
    }
  }
  private unit(id: string, gateway = false) {
    return unitName(this.instanceId, id, gateway);
  }
  private socketOwner(id: string) {
    return { instanceId: this.instanceId, appId: id };
  }
  configureOrigins(origins: string[]) {
    this.allowedOrigins = [
      ...new Set(
        origins.map((origin) => {
          const url = new URL(origin);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.origin !== origin ||
            url.username ||
            url.password
          )
            throw new Error("Jelly origins must be canonical HTTP(S) origins.");
          return url.origin;
        }),
      ),
    ];
    for (const app of this.rows())
      this.save({ ...app, allowedJellyOrigins: this.allowedOrigins });
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
  private unlocked(id: string) {
    const lock = this.store.db
      .query("SELECT expiresAt FROM app_locks WHERE appId=?")
      .get(id) as { expiresAt: number } | null;
    if (lock && lock.expiresAt > Date.now())
      throw new HttpError(
        409,
        "An app lifecycle operation is in progress. Retry after it finishes.",
      );
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
      capabilities: this.cachedCapabilities,
    };
  }
  register(
    input: Record<string, unknown>,
    defaults?: { builderAgentId: string; projectId: string | null },
  ): AppRecord {
    const app = this.store.db.transaction(() =>
      this.registerRecord(input, defaults),
    )();
    return this.changed(app);
  }
  private registerRecord(
    input: Record<string, unknown>,
    defaults?: { builderAgentId: string; projectId: string | null },
  ): AppRecord {
    if (this.closed) throw new HttpError(503, "Apps service is closing.");
    for (const field of [
      "runtimePort",
      "runtimeSocket",
      "gatewayPort",
      "unitName",
      "deploymentRevision",
      "desiredState",
      "starredAt",
      "lastOpenedAt",
      "createdAt",
      "updatedAt",
      "observation",
      "allowedJellyOrigins",
      "executable",
      "args",
      "healthPath",
    ])
      if (input[field] !== undefined)
        throw new HttpError(
          400,
          `${field} is server-controlled. Use the deployment/lifecycle tools.`,
        );
    const namedId = input.id === undefined ? undefined : appId(input.id);
    const prior = namedId
      ? (this.store.db
          .query("SELECT record FROM apps WHERE id=?")
          .get(namedId) as { record: string } | null)
      : null;
    const priorApp: AppRecord | undefined = prior
      ? JSON.parse(prior.record)
      : undefined;
    const name = appText(input.name ?? priorApp?.name, "Name", 100);
    const slug = appSlug(
      input.slug ??
        priorApp?.slug ??
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
    );
    const bySlug = this.store.db
      .query("SELECT id FROM apps WHERE slug=?")
      .get(slug) as { id: string } | null;
    const id =
      input.id === undefined
        ? (bySlug?.id ?? crypto.randomUUID())
        : appId(input.id);
    const resource = this.resources(id);
    const existingRow = this.store.db
      .query("SELECT record FROM apps WHERE id=?")
      .get(id) as { record: string } | null;
    const existing: AppRecord | undefined = existingRow
      ? JSON.parse(existingRow.record)
      : undefined;
    if (!existing && defaults)
      input = {
        ...defaults,
        ...Object.fromEntries(
          Object.entries(input).filter(([, value]) => value !== undefined),
        ),
      };
    this.unlocked(id);
    if (bySlug && bySlug.id !== id)
      throw new HttpError(409, "Another app already uses that slug.");
    if (resource && !existing)
      throw new HttpError(
        409,
        "This unregistered app still owns running resources; register with a new app ID. Source/data have been retained.",
      );
    const mode =
      input.managementMode ??
      existing?.managementMode ??
      (input.url || input.localOrigin || input.tailnetOrigin
        ? "linked"
        : "managed");
    if (mode !== "managed" && mode !== "linked")
      throw new HttpError(400, "Invalid management mode.");
    if (existing && existing.managementMode !== mode)
      throw new HttpError(
        409,
        "Linked app adoption is not automatic. Register a separate managed app.",
      );
    if (
      input.launchMode !== undefined &&
      input.launchMode !== "embedded" &&
      input.launchMode !== "direct"
    )
      throw new HttpError(400, "Invalid launch mode.");
    if (
      existing?.deploymentRevision &&
      input.launchMode !== undefined &&
      input.launchMode !== existing.launchMode
    )
      throw new HttpError(
        409,
        "Changing a deployed launch mode requires redeployment so gateway policy and launcher stay synchronized.",
      );
    let origins = {
      localOrigin: existing?.localOrigin ?? null,
      tailnetOrigin: existing?.tailnetOrigin ?? null,
    };
    if (mode === "linked") {
      if (
        input.url !== undefined &&
        (input.localOrigin !== undefined || input.tailnetOrigin !== undefined)
      )
        throw new HttpError(
          400,
          "Use a single private URL or separate local/tailnet origins, not both.",
        );
      if (input.url !== undefined)
        origins = linkedOrigin(input.url, this.allowedOrigins);
      else if (
        input.localOrigin !== undefined ||
        input.tailnetOrigin !== undefined
      ) {
        const local =
          input.localOrigin == null
            ? null
            : linkedOrigin(input.localOrigin, this.allowedOrigins);
        const remote =
          input.tailnetOrigin == null
            ? null
            : linkedOrigin(input.tailnetOrigin, this.allowedOrigins);
        if (remote && !remote.tailnetOrigin)
          throw new HttpError(
            400,
            "A remote app origin cannot use loopback. Supply a private Tailscale origin.",
          );
        origins = {
          localOrigin:
            input.localOrigin === undefined
              ? (existing?.localOrigin ?? remote?.localOrigin ?? null)
              : (local?.localOrigin ?? null),
          tailnetOrigin:
            input.tailnetOrigin === undefined
              ? (local?.tailnetOrigin ?? existing?.tailnetOrigin ?? null)
              : (remote?.tailnetOrigin ?? null),
        };
      }
      if (!existing && !origins.localOrigin && !origins.tailnetOrigin)
        throw new HttpError(400, "A new linked app requires a private origin.");
      for (const origin of [origins.localOrigin, origins.tailnetOrigin])
        if (origin) linkedOrigin(origin, this.allowedOrigins);
      if (input.launchMode === "embedded")
        throw new HttpError(
          400,
          "Linked apps open directly; independent hosts and host-only cookies are required.",
        );
    } else if (
      input.url !== undefined ||
      input.localOrigin !== undefined ||
      input.tailnetOrigin !== undefined
    )
      throw new HttpError(400, "Managed origins are allocated by Jelly.");
    for (const [field, getter] of [
      ["projectId", (id: string) => this.store.project(id)],
      ["builderAgentId", (id: string) => this.store.agent(id)],
    ] as const)
      if (
        input[field] !== undefined &&
        input[field] !== null &&
        !getter(appId(input[field]))
      )
        throw new HttpError(404, `${field} not found.`);
    let source = existing?.sourceDirectory ?? null;
    if (input.sourceDirectory !== undefined) {
      source =
        input.sourceDirectory === null
          ? null
          : appText(input.sourceDirectory, "Source directory", 4096);
      if (source && !isAbsolute(source))
        throw new HttpError(400, "Source directory must be absolute.");
    }
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
          "iconAssetId must reference a valid raster asset owned by this app. Upload through the app icon endpoint.",
        );
      }
    }
    const now = this.now();
    const app: AppRecord = {
      id,
      slug,
      name,
      description:
        input.description === undefined
          ? (existing?.description ?? "")
          : appText(input.description, "Description", 4000, true),
      iconAssetId,
      projectId:
        input.projectId === undefined
          ? (existing?.projectId ?? null)
          : input.projectId === null
            ? null
            : appId(input.projectId),
      builderAgentId:
        input.builderAgentId === undefined
          ? (existing?.builderAgentId ?? null)
          : input.builderAgentId === null
            ? null
            : appId(input.builderAgentId),
      sourceDirectory: source,
      managementMode: mode,
      launchMode:
        mode === "linked"
          ? "direct"
          : ((input.launchMode as AppRecord["launchMode"]) ??
            existing?.launchMode ??
            "embedded"),
      runtimeSocket: existing?.runtimeSocket ?? null,
      gatewayPort: existing?.gatewayPort ?? null,
      unitName: existing?.unitName ?? null,
      deploymentRevision: existing?.deploymentRevision ?? null,
      executable: existing?.executable ?? null,
      args: existing?.args ?? [],
      healthPath: existing?.healthPath ?? null,
      ...origins,
      allowedJellyOrigins: this.allowedOrigins,
      desiredState:
        existing?.desiredState ?? (mode === "linked" ? "ready" : "draft"),
      starredAt: existing?.starredAt ?? null,
      lastOpenedAt: existing?.lastOpenedAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      viewerCorner:
        input.viewerCorner === undefined
          ? (existing?.viewerCorner ?? "top-left")
          : appCorner(input.viewerCorner),
      observation: existing?.observation ?? unknownObservation(),
    };
    return this.save(app);
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
    return this.locked(appId(id), async () => {
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
    });
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
      // Durable deduplication is deliberately not evicted by health probes/restarts.
      return this.save({ ...existing, lastOpenedAt: now, updatedAt: now });
    })();
    return this.changed(app);
  }
  async capabilities(): Promise<AppsCapabilities> {
    this.cachedCapabilities = await this.adapter.capabilities();
    return this.cachedCapabilities;
  }
  private resources(id: string) {
    return this.store.db
      .query("SELECT * FROM app_resources WHERE appId=?")
      .get(id) as Resources | null;
  }
  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new HttpError(503, "Apps service is closing.");
    this.store.db.transaction(() => {
      this.store.db
        .query("DELETE FROM app_locks WHERE appId=? AND expiresAt<=?")
        .run(id, Date.now());
      const inserted = this.store.db
        .query(
          "INSERT OR IGNORE INTO app_locks(appId,owner,expiresAt) VALUES (?,?,?)",
        )
        .run(id, this.owner, Date.now() + 3600000);
      if (!inserted.changes)
        throw new HttpError(
          409,
          "An app lifecycle operation is already in progress. Retry later; interrupted-operation leases expire within one hour.",
        );
    })();
    const renewal = setInterval(
      () =>
        this.store.db
          .query("UPDATE app_locks SET expiresAt=? WHERE appId=? AND owner=?")
          .run(Date.now() + 3600000, id, this.owner),
      30000,
    );
    renewal.unref();
    const promise = operation();
    this.active.add(promise);
    try {
      return await promise;
    } finally {
      clearInterval(renewal);
      this.active.delete(promise);
      this.store.db
        .query("DELETE FROM app_locks WHERE appId=? AND owner=?")
        .run(id, this.owner);
    }
  }
  private async reserve(id: string, addresses: string[]): Promise<Resources> {
    const existing = this.resources(id);
    if (existing) return existing;
    const ports: number[] = [];
    try {
      for (const kind of ["gateway"] as const) {
        let chosen: number | undefined;
        for (
          let port = this.options.portMin ?? 32000;
          port <= (this.options.portMax ?? 42000);
          port++
        ) {
          const reserved = this.store.db
            .query(
              "INSERT OR IGNORE INTO app_ports(port,appId,kind) VALUES (?,?,?)",
            )
            .run(port, id, kind);
          if (!reserved.changes) continue;
          if (
            await this.adapter.portAvailable(port, ["127.0.0.1", ...addresses])
          ) {
            chosen = port;
            ports.push(port);
            break;
          }
          this.store.db
            .query("DELETE FROM app_ports WHERE port=? AND appId=?")
            .run(port, id);
        }
        if (!chosen)
          throw new HttpError(
            409,
            "No available private app ports. Free listeners or widen the configured Apps port range.",
          );
      }
      const resource = {
        appId: id,
        unitName: this.unit(id),
        runtimeSocket: runtimeSocketPath(
          this.socketOwner(id),
          this.options.socketBaseDir,
        ),
        gatewayPort: ports[0]!,
      };
      this.store.db
        .query(
          "INSERT INTO app_resources(appId,unitName,runtimeSocket,gatewayPort) VALUES (?,?,?,?)",
        )
        .run(
          id,
          resource.unitName,
          resource.runtimeSocket,
          resource.gatewayPort,
        );
      return resource;
    } catch (error) {
      this.store.db.query("DELETE FROM app_ports WHERE appId=?").run(id);
      throw error;
    }
  }
  private async ownedUnits(id: string, required = false) {
    const resources = this.resources(id);
    if (resources && resources.unitName !== this.unit(id))
      throw new HttpError(
        409,
        "Legacy/foreign app unit ownership is unavailable; ID-only units are never adopted.",
      );
    for (const name of [this.unit(id), this.unit(id, true)]) {
      const content = await this.adapter.readUnit(name);
      if (
        (required && !content) ||
        (content && !content.startsWith(unitOwner(this.instanceId, id)))
      )
        throw new HttpError(
          409,
          "App unit ownership conflict. Refusing to control or replace foreign/missing units.",
        );
    }
  }
  private release(id: string, revision: string): Release {
    const row = this.store.db
      .query(
        "SELECT configuration FROM app_releases WHERE appId=? AND revision=?",
      )
      .get(id, revision) as { configuration: string } | null;
    if (!row)
      throw new HttpError(
        409,
        "Retained app release configuration is unavailable.",
      );
    return JSON.parse(row.configuration);
  }
  private async snapshotSource(source: string, destination: string) {
    const canonical = await realpath(source);
    // Never copy instance state recursively or allow symlinks to copy private external files.
    if (
      this.root === canonical ||
      this.root.startsWith(canonical + "/") ||
      canonical.startsWith(this.root + "/")
    )
      throw new HttpError(
        400,
        "Source directory must be outside the instance Apps data directory.",
      );
    const excluded = (path: string) =>
      relative(canonical, path)
        .split(sep)
        .some((part) => part === ".git" || /^\.env(?:\.|$)/.test(part));
    const contained = async (path: string) => {
      const target = await realpath(path);
      const inside = relative(canonical, target);
      if (
        inside === ".." ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside)
      )
        throw new HttpError(
          400,
          "Source symlinks must stay inside the source directory. Install dependencies inside the release with the build command.",
        );
      return target;
    };
    const inspect = async (directory: string, ancestors: Set<string>) => {
      const target = await contained(directory);
      if (excluded(target)) return;
      if (ancestors.has(target))
        throw new HttpError(
          400,
          "Source symlink directories must not form cycles.",
        );
      const next = new Set(ancestors).add(target);
      for (const entry of await readdir(target, { withFileTypes: true })) {
        const path = join(target, entry.name);
        if (excluded(path)) continue;
        const resolved = await contained(path);
        if (excluded(resolved)) continue;
        if ((await stat(resolved)).isDirectory()) await inspect(resolved, next);
      }
    };
    // Walk dereferenced directories too: validating an alias's immediate target
    // says nothing about nested aliases, excluded targets or directory cycles.
    await inspect(canonical, new Set());
    await cp(canonical, destination, {
      recursive: true,
      dereference: true,
      // Revalidate each resolved copy target; lexical paths alone let innocuous
      // directory aliases reintroduce excluded metadata and environment files.
      filter: async (path) =>
        !excluded(path) && !excluded(await contained(path)),
    });
  }
  private mapped(executable: string, source: string, releaseSource: string) {
    const path = relative(source, executable);
    if (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
      return join(releaseSource, path);
    if (
      executable.includes("/worktrees/") ||
      executable.includes("/pi-worktree-")
    )
      throw new HttpError(
        400,
        "Production executables must not reference an ephemeral worktree.",
      );
    return executable;
  }
  private substitutions(
    args: string[],
    socket: string,
    dataDir: string,
    source?: string,
    releaseSource?: string,
  ) {
    return args.map((arg) => {
      let value = arg
        .replaceAll("{socket}", socket)
        .replaceAll("{dataDir}", dataDir);
      if (source && releaseSource && isAbsolute(value))
        value = this.mapped(value, source, releaseSource);
      if (value.includes("/worktrees/") || value.includes("/pi-worktree-"))
        throw new HttpError(
          400,
          "Command arguments must not reference an ephemeral worktree. Use paths relative to the release directory.",
        );
      return value;
    });
  }
  private async persistentScripts() {
    const gateway = await readFile(
      new URL("../../scripts/app-gateway.ts", import.meta.url),
      "utf8",
    );
    const sockets = await readFile(
      new URL("./apps-sockets.ts", import.meta.url),
      "utf8",
    );
    const hash = createHash("sha256")
      .update(gateway + launcher + sockets)
      .digest("hex")
      .slice(0, 20);
    const directory = join(this.root, "runtime", hash);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const install = async (name: string, content: string) => {
      const temporary = join(directory, `.${name}.${crypto.randomUUID()}`);
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, join(directory, name));
    };
    const bundled = await Bun.build({
      entrypoints: [
        new URL("../../scripts/app-gateway.ts", import.meta.url).pathname,
      ],
      target: "node",
    });
    if (!bundled.success || bundled.outputs.length !== 1)
      throw new Error("Could not bundle the persistent gateway.");
    await install("app-gateway.mjs", await bundled.outputs[0]!.text());
    await install(
      "app-sockets.mjs",
      new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(
        sockets,
      ),
    );
    await install("app-launcher.ts", launcher);
    return directory;
  }
  private async quarantine(app: AppRecord, reason?: string): Promise<never> {
    await this.ownedUnits(app.id, true);
    let lastError = `Unsafe runtime isolation: ${reason ?? "TCP listener, invalid socket ownership, or unverifiable owned cgroup"}. `;
    let serviceState: AppObservation["serviceState"] = "stopped";
    try {
      await this.adapter.systemctl("stop", [
        this.unit(app.id),
        this.unit(app.id, true),
      ]);
      lastError +=
        "Both owned runtime and gateway were stopped; inspect logs before retrying.";
    } catch {
      serviceState = "failed";
      lastError +=
        "Stopping owned services failed; operator intervention is required.";
    }
    this.changed(
      this.save({
        ...this.get(app.id),
        desiredState: "stopped",
        observation: {
          serviceState,
          httpHealthy: false,
          tailnetReachable: null,
          checkedAt: this.now(),
          lastError,
        },
        updatedAt: this.now(),
      }),
    );
    await writeFile(join(this.root, `last-failure-${app.id}.log`), lastError, {
      mode: 0o600,
    }).catch(() => {});
    throw new UnsafeRuntimeError(502, lastError);
  }
  private async checked(app: AppRecord): Promise<AppObservation> {
    const resource = this.resources(app.id);
    if (
      app.unitName !== this.unit(app.id) ||
      resource?.unitName !== this.unit(app.id) ||
      !app.runtimeSocket ||
      resource.runtimeSocket !== app.runtimeSocket
    )
      return {
        ...unknownObservation(),
        httpHealthy: false,
        checkedAt: this.now(),
        lastError:
          "Legacy/foreign app service ownership is unavailable; ID-only units are never adopted.",
      };
    await this.ownedUnits(app.id, true);
    const serviceState = await this.adapter.state(this.unit(app.id));
    const gatewayState = await this.adapter.state(this.unit(app.id, true));
    const isolation = await this.adapter.runtimeIsolation(
      this.unit(app.id),
      app.runtimeSocket,
      this.socketOwner(app.id),
    );
    if (!isolation.safe) return this.quarantine(app, isolation.reason);
    const retained = app.deploymentRevision
      ? this.release(app.id, app.deploymentRevision)
      : null;
    const configured =
      !!retained &&
      (await this.adapter.readUnit(app.unitName!)) === retained.runtimeUnit &&
      (await this.adapter.readUnit(this.unit(app.id, true))) ===
        retained.gatewayUnit;
    const httpHealthy =
      configured &&
      serviceState === "running" &&
      gatewayState === "running" &&
      isolation.ready &&
      (await this.adapter.socketHealth(app.runtimeSocket, app.healthPath!)) &&
      (await this.adapter.health(
        `http://127.0.0.1:${app.gatewayPort}`,
        app.healthPath!,
        {
          instanceId: this.instanceId,
          appId: app.id,
          deploymentRevision: app.deploymentRevision!,
        },
      ));
    return {
      serviceState,
      httpHealthy,
      checkedAt: this.now(),
      tailnetReachable: null,
      lastError: httpHealthy
        ? null
        : !configured
          ? "App units do not match the last-good release. Restart the app to restore its confirmed configuration."
          : "App runtime/gateway is stopped, socket-not-ready, or HTTP-unhealthy. Check app logs and restart.",
    };
  }
  private async awaitHealth(app: AppRecord) {
    let observation = unknownObservation();
    for (
      let attempt = 0;
      attempt < (this.options.healthAttempts ?? 20);
      attempt++
    ) {
      observation = await this.checked(app);
      if (observation.httpHealthy) return observation;
      if (attempt + 1 < (this.options.healthAttempts ?? 20))
        await Bun.sleep(this.options.healthDelayMs ?? 1000);
    }
    throw new HttpError(
      502,
      "App did not pass checked Unix socket runtime and gateway health. Managed apps must accept APP_SOCKET; TCP-only runtimes are unsupported. Inspect logs; previous healthy release will be restored when available.",
    );
  }
  async deploy(
    input: AppManifest | Record<string, unknown>,
    defaults?: { builderAgentId: string; projectId: string | null },
  ): Promise<AppRecord> {
    const manifest = validateManifest(input);
    const capabilities = await this.capabilities();
    if (!capabilities.supported)
      throw new HttpError(
        501,
        "Managed Apps are unsupported on this platform. Use a linked private app on an independent host.",
      );
    if (!capabilities.managedDeployment)
      throw new HttpError(503, capabilities.warnings.join(" "));
    const metadata: Record<string, unknown> = {
      name: manifest.name,
      slug: manifest.slug,
      description: manifest.description,
      id: manifest.id,
      projectId: manifest.projectId,
      builderAgentId: manifest.builderAgentId,
      sourceDirectory: manifest.sourceDirectory,
      managementMode: "managed",
      // Policy changes become visible only after gateway activation succeeds.
      launchMode: undefined,
      viewerCorner: manifest.viewerCorner,
    };
    const registered = this.register(metadata, defaults);
    const id = registered.id;
    return this.locked(id, async () => {
      const old = this.get(id);
      const previous = old.deploymentRevision
        ? this.release(id, old.deploymentRevision)
        : null;
      const revision = crypto.randomUUID();
      const directory = join(this.root, "releases", id, revision);
      const source = join(directory, "source");
      const dataDir = join(this.root, "data", id);
      let resources = this.resources(id);
      const hadResources = !!resources;
      let activated = false;
      let oldRuntime: string | null = null;
      let oldGateway: string | null = null;
      this.changed(
        this.save({
          ...old,
          desiredState: "deploying",
          updatedAt: this.now(),
          observation: {
            ...old.observation,
            serviceState: "starting",
            lastError: null,
          },
        }),
      );
      try {
        if (previous && !manifest.migrationPlan)
          throw new HttpError(
            400,
            "Redeployment requires an explicit storage migration compatibility/backup plan. Code rollback does not undo data migrations.",
          );
        resources ??= await this.reserve(id, capabilities.tailnetAddresses);
        oldRuntime = await this.adapter.readUnit(resources.unitName);
        oldGateway = await this.adapter.readUnit(this.unit(id, true));
        await this.ownedUnits(id);
        if (
          previous &&
          (oldRuntime !== previous.runtimeUnit ||
            oldGateway !== previous.gatewayUnit)
        ) {
          await this.adapter.installUnit(
            resources.unitName,
            previous.runtimeUnit,
          );
          await this.adapter.installUnit(
            this.unit(id, true),
            previous.gatewayUnit,
          );
          await this.adapter.systemctl("daemon-reload");
          await this.adapter.systemctl(
            old.desiredState === "stopped" ? "stop" : "restart",
            [resources.unitName, this.unit(id, true)],
          );
          oldRuntime = previous.runtimeUnit;
          oldGateway = previous.gatewayUnit;
        }
        if (!resources.runtimeSocket)
          throw new HttpError(
            409,
            "TCP-only legacy resources cannot be adopted; operator cleanup is required.",
          );
        await verifySocketParent(
          resources.runtimeSocket,
          this.socketOwner(id),
          true,
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        this.store.db
          .query(
            "INSERT INTO app_releases(appId,revision,configuration,createdAt) VALUES (?,?,?,?)",
          )
          .run(
            id,
            revision,
            JSON.stringify({
              directory,
              manifest,
              runtimeUnit: "",
              gatewayUnit: "",
              app: old,
            } satisfies Release),
            this.now(),
          );
        await this.snapshotSource(manifest.sourceDirectory, source);
        // Validation never receives durable runtime storage, including argv substitutions.
        const validationDataDir = await mkdtemp(
          join(tmpdir(), "jelly-app-validation-"),
        );
        try {
          const env = {
            HOST: "127.0.0.1",
            PORT: "0",
            APP_SOCKET: join(validationDataDir, "http.sock"),
            APP_DATA_DIR: validationDataDir,
            JELLY_APP_ID: id,
            JELLY_ALLOWED_ORIGINS: JSON.stringify(this.allowedOrigins),
            JELLY_VIEWER_CORNER: manifest.viewerCorner ?? old.viewerCorner,
          };
          for (const [label, command] of [
            ["Build", manifest.build],
            ["Test", manifest.test],
          ] as const) {
            if (!command) continue;
            const result = await this.adapter.command(
              this.mapped(command.executable, manifest.sourceDirectory, source),
              this.substitutions(
                command.args,
                join(validationDataDir, "http.sock"),
                validationDataDir,
                manifest.sourceDirectory,
                source,
              ),
              { cwd: source, env, timeoutMs: 600000 },
            );
            await writeFile(
              join(directory, `${label.toLowerCase()}.log`),
              redactAppDiagnostics(result.stdout + "\n" + result.stderr),
              { mode: 0o600 },
            );
            if (result.code)
              throw new HttpError(
                422,
                `${label} failed; app was not activated. Inspect sanitized Apps logs.`,
              );
          }
        } finally {
          await rm(validationDataDir, { recursive: true, force: true });
        }
        const executable = this.mapped(
          manifest.executable,
          manifest.sourceDirectory,
          source,
        );
        try {
          const info = await stat(executable);
          if (!info.isFile() || !(info.mode & 0o111)) throw new Error();
        } catch {
          throw new HttpError(
            400,
            "Runtime executable must exist and be executable after build/test.",
          );
        }
        const scripts = await this.persistentScripts();
        const cookieKeyPath = join(dataDir, "gateway-cookie-key");
        let cookieKey: string;
        try {
          cookieKey = (await readFile(cookieKeyPath, "utf8")).trim();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          cookieKey = randomBytes(32).toString("hex");
          await writeFile(cookieKeyPath, cookieKey, {
            mode: 0o600,
            flag: "wx",
          });
        }
        const args = this.substitutions(
          manifest.args,
          resources.runtimeSocket,
          dataDir,
          manifest.sourceDirectory,
          source,
        );
        await writeFile(
          join(directory, "launcher.json"),
          JSON.stringify({
            executable,
            args,
            cwd: source,
            runtimeSocket: resources.runtimeSocket,
            instanceId: this.instanceId,
            dataDir,
            appId: id,
            allowedOrigins: this.allowedOrigins,
            viewerCorner: manifest.viewerCorner ?? old.viewerCorner,
          }),
          { mode: 0o600 },
        );
        const launchMode = this.allowedOrigins.some((origin) =>
          origin.startsWith("https:"),
        )
          ? "direct"
          : (manifest.launchMode ?? old.launchMode);
        await writeFile(
          join(directory, "gateway.json"),
          JSON.stringify({
            appId: id,
            instanceId: this.instanceId,
            runtimeSocket: resources.runtimeSocket,
            gatewayPort: resources.gatewayPort,
            cookieKey,
            deploymentRevision: revision,
            launchMode,
            allowedJellyOrigins: this.allowedOrigins,
          }),
          { mode: 0o600 },
        );
        if (
          process.execPath.includes("/worktrees/") ||
          process.execPath.includes("/pi-worktree-")
        )
          throw new HttpError(
            400,
            "Bun must be installed at a persistent production path.",
          );
        const runtimeUnit = appUnit(
          this.instanceId,
          id,
          [
            process.execPath,
            join(scripts, "app-launcher.ts"),
            join(directory, "launcher.json"),
          ],
          source,
          manifest.environmentFiles,
        );
        const gatewayExecutable = await this.adapter.gatewayExecutable();
        if (
          !isAbsolute(gatewayExecutable) ||
          gatewayExecutable.includes("/worktrees/") ||
          gatewayExecutable.includes("/pi-worktree-")
        )
          throw new HttpError(
            503,
            "Gateway Node executable must have a persistent absolute path.",
          );
        const gatewayUnit = appUnit(
          this.instanceId,
          id,
          [
            gatewayExecutable,
            join(scripts, "app-gateway.mjs"),
            join(directory, "gateway.json"),
          ],
          directory,
          [],
          true,
        );
        // Never publish raw runtime origins. Public URLs always point at the isolated gateway.
        const tailnetHost =
          capabilities.tailnetHostname ?? capabilities.tailnetAddresses[0];
        const candidate: AppRecord = {
          ...this.get(id),
          sourceDirectory: manifest.sourceDirectory,
          executable: manifest.executable,
          args: manifest.args,
          runtimeSocket: resources.runtimeSocket,
          gatewayPort: resources.gatewayPort,
          unitName: resources.unitName,
          deploymentRevision: revision,
          healthPath: manifest.healthPath!,
          localOrigin: `http://127.0.0.1:${resources.gatewayPort}`,
          tailnetOrigin: tailnetHost
            ? `http://${tailnetHost.includes(":") ? `[${tailnetHost}]` : tailnetHost}:${resources.gatewayPort}`
            : null,
          launchMode,
        };
        const release: Release = {
          directory,
          runtimeUnit,
          gatewayUnit,
          manifest,
          app: candidate,
        };
        this.store.db
          .query(
            "UPDATE app_releases SET configuration=? WHERE appId=? AND revision=?",
          )
          .run(JSON.stringify(release), id, revision);
        await this.adapter.installUnit(resources.unitName, runtimeUnit);
        activated = true;
        await this.adapter.installUnit(this.unit(id, true), gatewayUnit);
        await this.adapter.systemctl("daemon-reload");
        await this.adapter.systemctl("enable", [
          resources.unitName,
          this.unit(id, true),
        ]);
        await this.adapter.systemctl("restart", [
          resources.unitName,
          this.unit(id, true),
        ]);
        const observation = await this.awaitHealth(candidate);
        // Star/launch mutations during deployment are preserved, not snapshotted away.
        const current = this.get(id);
        return this.changed(
          this.save({
            ...candidate,
            starredAt: current.starredAt,
            lastOpenedAt: current.lastOpenedAt,
            desiredState: "ready",
            observation,
            updatedAt: this.now(),
          }),
        );
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? error.message
            : "App deployment failed. Inspect sanitized logs and user service capabilities.";
        let rollbackObservation: AppObservation | null = null;
        let cleanupFailed = false;
        if (activated && resources) {
          try {
            // Disable/stop while ownership files still exist. Removing first leaves
            // dangling boot links and makes real systemctl cleanup fail unloaded.
            if (!previous) {
              await this.adapter.systemctl("stop", [
                resources.unitName,
                this.unit(id, true),
              ]);
              await this.adapter.systemctl("disable", [
                resources.unitName,
                this.unit(id, true),
              ]);
            }
            if (oldRuntime)
              await this.adapter.installUnit(resources.unitName, oldRuntime);
            else await this.adapter.removeUnit(resources.unitName);
            if (oldGateway)
              await this.adapter.installUnit(this.unit(id, true), oldGateway);
            else await this.adapter.removeUnit(this.unit(id, true));
            await this.adapter.systemctl("daemon-reload");
            if (previous) {
              await this.adapter.systemctl(
                old.desiredState === "stopped" ? "stop" : "restart",
                [resources.unitName, this.unit(id, true)],
              );
              rollbackObservation =
                old.desiredState === "stopped"
                  ? {
                      ...old.observation,
                      serviceState: "stopped",
                      httpHealthy: false,
                      checkedAt: this.now(),
                    }
                  : await this.awaitHealth(previous.app);
            }
          } catch {
            cleanupFailed = true;
          }
        }
        if (!hadResources && !cleanupFailed && resources?.runtimeSocket) {
          try {
            await removeRuntimeSocket(
              resources.runtimeSocket,
              this.socketOwner(id),
            );
          } catch {
            cleanupFailed = true;
          }
        }
        if (!hadResources && !cleanupFailed)
          this.store.db.transaction(() => {
            this.store.db
              .query("DELETE FROM app_resources WHERE appId=?")
              .run(id);
            this.store.db.query("DELETE FROM app_ports WHERE appId=?").run(id);
          })();
        const current = this.get(id);
        const restored = {
          ...old,
          starredAt: current.starredAt,
          lastOpenedAt: current.lastOpenedAt,
          desiredState: previous ? old.desiredState : ("draft" as const),
          updatedAt: this.now(),
          observation: {
            ...(rollbackObservation ?? old.observation),
            serviceState:
              rollbackObservation?.serviceState ??
              (activated || !previous
                ? "failed"
                : old.observation.serviceState),
            httpHealthy:
              rollbackObservation?.httpHealthy ??
              (previous && !activated ? old.observation.httpHealthy : false),
            checkedAt: this.now(),
            lastError:
              failure +
              (cleanupFailed
                ? " Rollback/cleanup also failed; resources retained to prevent collisions. Inspect units before retrying."
                : ""),
          },
        };
        this.changed(this.save(restored));
        await writeFile(
          join(this.root, "last-failure-" + id + ".log"),
          restored.observation.lastError!,
          { mode: 0o600 },
        ).catch(() => {});
        throw new HttpError(
          error instanceof HttpError ? error.status : 502,
          restored.observation.lastError!,
        );
      }
    });
  }
  async control(
    id: string,
    action: "start" | "stop" | "restart",
  ): Promise<AppRecord> {
    if (!["start", "stop", "restart"].includes(action))
      throw new HttpError(400, "Invalid app lifecycle action.");
    return this.locked(appId(id), async () => {
      const app = this.get(id);
      if (
        app.managementMode !== "managed" ||
        !app.unitName ||
        !app.deploymentRevision
      )
        throw new HttpError(
          409,
          "Only deployed Jelly-managed apps have service controls.",
        );
      const resource = this.resources(id);
      if (
        !resource ||
        resource.unitName !== this.unit(id) ||
        resource.unitName !== app.unitName
      )
        throw new HttpError(409, "App service ownership is unavailable.");
      await this.ownedUnits(id, true);
      try {
        const retained = this.release(id, app.deploymentRevision);
        const repairing =
          (await this.adapter.readUnit(resource.unitName)) !==
            retained.runtimeUnit ||
          (await this.adapter.readUnit(this.unit(id, true))) !==
            retained.gatewayUnit;
        if (repairing) {
          await this.adapter.installUnit(
            resource.unitName,
            retained.runtimeUnit,
          );
          await this.adapter.installUnit(
            this.unit(id, true),
            retained.gatewayUnit,
          );
          await this.adapter.systemctl("daemon-reload");
        }
        await this.adapter.systemctl(
          repairing && action === "start" ? "restart" : action,
          [resource.unitName, this.unit(id, true)],
        );
        const observation: AppObservation =
          action === "stop"
            ? {
                serviceState: "stopped",
                httpHealthy: false,
                checkedAt: this.now(),
                tailnetReachable: null,
                lastError: null,
              }
            : await this.awaitHealth(app);
        return this.changed(
          this.save({
            ...this.get(id),
            desiredState: action === "stop" ? "stopped" : "ready",
            observation,
            updatedAt: this.now(),
          }),
        );
      } catch (error) {
        if (error instanceof UnsafeRuntimeError) throw error;
        const serviceState = await this.adapter
          .state(this.unit(id))
          .catch(() => "unknown" as const);
        const failed = this.changed(
          this.save({
            ...this.get(id),
            observation: {
              ...app.observation,
              serviceState,
              httpHealthy: false,
              checkedAt: this.now(),
              lastError:
                "App control failed; inspect app logs and user systemd capabilities.",
            },
            updatedAt: this.now(),
          }),
        );
        throw new HttpError(502, failed.observation.lastError!);
      }
    });
  }
  async logs(
    id: string,
    limit = 100,
  ): Promise<{ text: string; warning: string }> {
    const app = this.get(id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new HttpError(400, "Log limit must be between 1 and 500.");
    if (app.managementMode !== "managed")
      throw new HttpError(409, "Linked app logs are not owned by Jelly.");
    let text = "";
    if (app.unitName && this.resources(id)) {
      await this.ownedUnits(id, true);
      text = await this.adapter.logs(
        [this.unit(id), this.unit(id, true)],
        limit,
      );
    }
    try {
      text +=
        "\n" +
        (await readFile(join(this.root, `last-failure-${id}.log`), "utf8"));
    } catch {
      /* First deployment has no failure diagnostics. */
    }
    const releases = this.store.db
      .query(
        "SELECT configuration FROM app_releases WHERE appId=? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(id) as { configuration: string } | null;
    if (releases) {
      const release = JSON.parse(releases.configuration) as Release;
      for (const name of ["build.log", "test.log"])
        try {
          text +=
            "\n" + (await readFile(join(release.directory, name), "utf8"));
        } catch {
          /* Build is optional. */
        }
    }
    return {
      text: redactAppDiagnostics(text).split("\n").slice(-limit).join("\n"),
      warning:
        "Diagnostics use best-effort redaction. App authors must never log secrets.",
    };
  }
  async remove(
    id: string,
    options: { uninstall: boolean },
  ): Promise<{ removed: true; serviceRetained: boolean; dataRetained: true }> {
    if (typeof options.uninstall !== "boolean")
      throw new HttpError(400, "uninstall must be a boolean.");
    return this.locked(appId(id), async () => {
      const app = this.get(id);
      const resource = this.resources(id);
      if (options.uninstall) {
        if (app.managementMode !== "managed")
          throw new HttpError(409, "Jelly cannot uninstall linked services.");
        if (resource) {
          if (resource.unitName !== this.unit(id))
            throw new HttpError(409, "App service ownership is unavailable.");
          await this.ownedUnits(id);
          await this.adapter.systemctl("stop", [
            resource.unitName,
            this.unit(id, true),
          ]);
          await this.adapter.systemctl("disable", [
            resource.unitName,
            this.unit(id, true),
          ]);
          await this.adapter.removeUnit(resource.unitName);
          await this.adapter.removeUnit(this.unit(id, true));
          if (resource.runtimeSocket)
            await removeRuntimeSocket(
              resource.runtimeSocket,
              this.socketOwner(id),
            );
          await this.adapter.systemctl("daemon-reload");
        }
      }
      this.store.db.transaction(() => {
        this.store.db.query("DELETE FROM apps WHERE id=?").run(id);
        if (options.uninstall) {
          this.store.db
            .query("DELETE FROM app_resources WHERE appId=?")
            .run(id);
          this.store.db.query("DELETE FROM app_ports WHERE appId=?").run(id);
        }
      })();
      this.options.emit?.("apps_removed", {
        id,
        serviceRetained: !!resource && !options.uninstall,
      });
      return {
        removed: true,
        serviceRetained: !!resource && !options.uninstall,
        dataRetained: true,
      };
    });
  }
  private async refresh() {
    const capabilities = await this.capabilities();
    for (const candidate of this.rows()) {
      if (this.closed) break;
      if (
        candidate.managementMode !== "managed" ||
        !candidate.unitName ||
        !candidate.deploymentRevision
      )
        continue;
      try {
        // Isolation checks can quarantine services. Hold the same renewable lease
        // as deployment/control through checking and publication, including a
        // same-revision restart; post-hoc revision checks cannot undo a stop.
        await this.locked(candidate.id, async () => {
          const app = this.get(candidate.id);
          if (
            app.managementMode !== "managed" ||
            !app.unitName ||
            !app.deploymentRevision
          )
            return;
          let observation: AppObservation;
          try {
            observation = await this.checked(app);
          } catch (error) {
            observation =
              error instanceof UnsafeRuntimeError
                ? this.get(app.id).observation
                : {
                    ...unknownObservation(),
                    httpHealthy: false,
                    checkedAt: this.now(),
                    lastError:
                      "App ownership/isolation observation failed; inspect units before retrying.",
                  };
          }
          // Stars and launches are independent of lifecycle leases. Re-read them
          // rather than publishing the record captured before asynchronous checks.
          const current = this.get(app.id);
          const host =
            capabilities.tailnetHostname ?? capabilities.tailnetAddresses[0];
          // Remote verification is unknown, never inferred from local HTTP.
          this.changed(
            this.save({
              ...current,
              tailnetOrigin: host
                ? `http://${host.includes(":") ? `[${host}]` : host}:${app.gatewayPort}`
                : null,
              desiredState:
                current.desiredState === "deploying"
                  ? current.deploymentRevision
                    ? "ready"
                    : "draft"
                  : current.desiredState,
              observation: {
                ...observation,
                lastError:
                  observation.lastError ?? current.observation.lastError,
              },
              updatedAt: this.now(),
            }),
          );
        });
      } catch (error) {
        // Busy apps are observed on the next tick. A removed app or a closing
        // service likewise must not generate destructive, stale work.
        if (
          error instanceof HttpError &&
          [404, 409, 503].includes(error.status)
        )
          continue;
        throw error;
      }
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([
      ...this.active,
      ...(this.refreshing ? [this.refreshing] : []),
    ]);
  }
}
