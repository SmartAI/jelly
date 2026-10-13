import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  deserializeMessage,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { DesktopConfig, DesktopStatus } from "../shared/desktop";

export const PEEKABOO_VERSION = "4.9.0";
export const QUALIFICATION_BLOCKER =
  "Connect the official signed Peekaboo 4.9.0 CLI/app for scoped native desktop tools. Missing host permissions or capabilities are reported explicitly. Lost/cancelled work remains quarantined; no replay or private handoff without completion proof.";
export const MAX_DESKTOP_PAYLOAD = 6 * 1024 * 1024;
export const MAX_DESKTOP_IMAGE = 4 * 1024 * 1024;
const TOOLS = [
  "permissions",
  "inspect_ui",
  "see",
  "click",
  "type",
  "press",
  "scroll",
];
export type DesktopCapabilities = DesktopStatus["capabilities"];
export type DesktopPermissions = DesktopStatus["permissions"];
export interface ProcessTarget {
  bundleId: string;
  pid: number;
  processStart: string;
}
export interface WindowTarget extends ProcessTarget {
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface ProviderElement {
  id: string;
  role: string;
  enabled: boolean;
  actionable: boolean;
  valueSettable?: boolean;
  secure?: boolean;
  value?: unknown;
  title?: unknown;
  label?: unknown;
}
export type SnapshotTarget = ProcessTarget & {
  windowId: number;
  bounds?: WindowTarget["bounds"];
};
export interface ProviderObservation {
  nativeSnapshot?: true;
  target: SnapshotTarget;
  complete?: boolean | null;
  coordinateReference?: string;
  imageSize?: { width: number; height: number };
  snapshotId: string;
  fresh: boolean;
  privacy: "non-sensitive" | "secure" | "unknown";
  surface: "standard" | "dialog" | "custom" | "unknown";
  elements: ProviderElement[];
  image?: { type: "image"; mimeType: "image/png"; data: string };
}
export interface ProviderMutation {
  kind: "click" | "type" | "key" | "scroll";
  target: SnapshotTarget;
  snapshotId: string;
  elementId?: string;
  text?: string;
  key?: string;
  count?: number;
  direction?: string;
  amount?: number;
  coordinates?: { x: number; y: number };
}
export type ProviderQualification =
  | { qualified: false; reason: string; permissions?: DesktopPermissions }
  | {
      qualified: true;
      version: "4.9.0";
      generation: string;
      identity: string;
      capabilities: DesktopCapabilities;
      permissions: DesktopPermissions;
      contracts:
        | {
            connectionBoundIdentity: true;
            generationBoundInventory: true;
            exactTargetReceipts: true;
          }
        | {
            nativePinnedConnection: true;
            discoveryOnlyInventory: true;
            exactTargetReceipts: true;
          };
    };
/** Released scoped routing delegates peer/snapshot binding to the signed native CLI.
 * Independent status guards are not persistent-connection attestation. */
export interface DesktopProvider {
  onDisconnect?: () => void;
  connect(
    config: DesktopConfig,
    guard: () => void,
  ): Promise<ProviderQualification>;
  apps(signal: AbortSignal): Promise<ProcessTarget[]>;
  windows(app: ProcessTarget, signal: AbortSignal): Promise<WindowTarget[]>;
  observe(
    target: WindowTarget,
    image: boolean,
    signal: AbortSignal,
  ): Promise<ProviderObservation>;
  mutate(input: ProviderMutation, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export type DesktopProviderFactory = (config: DesktopConfig) => DesktopProvider;
export const noDesktopCapabilities = (): DesktopCapabilities => ({
  observe: false,
  images: false,
  click: false,
  type: false,
  key: false,
  scroll: false,
  menu: false,
  foreground: false,
});
export const unknownDesktopPermissions = (): DesktopPermissions => ({
  accessibility: null,
  screenRecording: null,
  syntheticInput: null,
});
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Malformed desktop provider response; reconnect only after qualification.",
    );
  return value as Record<string, unknown>;
}
export function bounded(value: unknown, maximum = MAX_DESKTOP_PAYLOAD): void {
  // Bound depth/node count before JSON serialization (including injected providers).
  let nodes = 0,
    characters = 0;
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 20000 || depth > 24)
      throw new Error("Desktop response exceeds structural limits.");
    if (typeof item === "string") characters += item.length;
    else if (Array.isArray(item)) {
      if (item.length > 1000)
        throw new Error("Desktop response exceeds collection limits.");
      for (const child of item) visit(child, depth + 1);
    } else if (item && typeof item === "object") {
      const entries = Object.entries(item);
      if (entries.length > 100)
        throw new Error("Desktop response exceeds field limits.");
      for (const [key, child] of entries) {
        characters += key.length;
        visit(child, depth + 1);
      }
    }
    if (characters > maximum)
      throw new Error("Desktop response exceeds payload limits.");
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > maximum)
    throw new Error("Desktop response exceeds payload limits.");
}
export function restrictedPeekabooEnvironment(): Record<string, string> {
  // No inherited credentials, PATH overrides, alternate routing, input strategy or unsigned bypass.
  return {
    HOME: homedir(),
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    PEEKABOO_ALLOW_TOOLS: TOOLS.join(","),
  };
}

/** SDK's default stdio read buffer has no byte limit. Bound each line before SDK parsing. */
export class BoundedPeekabooTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  private process?: ReturnType<typeof spawn>;
  private pending = Buffer.alloc(0);
  private closed = false;
  private stderrBytes = 0;
  constructor(
    private command: string,
    private args: string[],
    private env = restrictedPeekabooEnvironment(),
  ) {}
  async start() {
    if (this.process || this.closed)
      throw new Error("Desktop transport cannot restart.");
    const child = (this.process = spawn(this.command, this.args, {
      shell: false,
      env: this.env,
      cwd: homedir(),
      stdio: "pipe",
    }));
    // Drain/discard with a lifetime byte budget; never log provider stderr or retain user content.
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 64 * 1024) {
        this.onerror?.(
          new Error(
            "Desktop MCP stderr limit exceeded; diagnostics redacted and host completion unknown.",
          ),
        );
        void this.close();
      }
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          if (this.pending.length + end - offset > MAX_DESKTOP_PAYLOAD)
            throw new Error("Oversized desktop MCP message.");
          this.pending = Buffer.concat([
            this.pending,
            chunk.subarray(offset, end),
          ]);
          if (newline < 0) break;
          const line = this.pending.toString("utf8");
          this.pending = Buffer.alloc(0);
          const message = deserializeMessage(line);
          this.onmessage?.(message);
          offset = newline + 1;
        }
      } catch {
        this.onerror?.(
          new Error(
            "Invalid or oversized desktop MCP message; host completion is unknown.",
          ),
        );
        void this.close();
      }
    });
    child.on("error", () => {
      this.onerror?.(
        new Error("Desktop MCP process failed; check the selected signed CLI."),
      );
      void this.close();
    });
    child.on("exit", () => this.finish());
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () =>
        reject(new Error("Cannot start selected desktop CLI.")),
      );
    });
  }
  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.pending = Buffer.alloc(0);
    this.onclose?.();
  }
  async send(message: JSONRPCMessage) {
    if (this.closed || !this.process?.stdin?.writable)
      throw new Error("Desktop MCP disconnected; host completion is unknown.");
    const data = serializeMessage(message);
    if (Buffer.byteLength(data) > MAX_DESKTOP_PAYLOAD)
      throw new Error("Desktop MCP request exceeds payload limit.");
    await new Promise<void>((resolve, reject) =>
      this.process!.stdin!.write(data, (error) =>
        error
          ? reject(
              new Error("Desktop MCP delivery failed; completion is unknown."),
            )
          : resolve(),
      ),
    );
  }
  async close() {
    // This revokes the Jelly proxy only, not the user-owned host, and is NOT a host drain barrier.
    this.process?.stdin?.destroy();
    this.process?.stdout?.destroy();
    this.process?.stderr?.destroy();
    this.process?.kill("SIGTERM");
    this.finish();
  }
}

export class PeekabooMcpClient {
  private client = new Client(
    { name: "jelly-desktop", version: "1.0.0" },
    { capabilities: {} },
  );
  private ready = false;
  private schemas = new Map<string, Record<string, unknown>>();
  onDisconnect?: () => void;
  constructor(private transport: Transport) {
    this.client.onclose = () => {
      this.ready = false;
      this.onDisconnect?.();
    };
  }
  async connect(guard: () => void = () => {}) {
    guard();
    await this.client.connect(this.transport, { timeout: 10000 });
    guard();
    const identity = this.client.getServerVersion();
    if (
      identity?.name !== "peekaboo-mcp" ||
      identity.version !== PEEKABOO_VERSION ||
      !this.client.getServerCapabilities()?.tools
    )
      throw new Error(
        "Require peekaboo-mcp 4.9.0 with live tools capability; select a matching signed release.",
      );
    guard();
    const listed = await this.client.listTools({}, { timeout: 10000 });
    guard();
    bounded(listed, 512 * 1024);
    if (listed.nextCursor)
      throw new Error("Unqualified paginated desktop tool catalog.");
    for (const tool of listed.tools) {
      if (this.schemas.has(tool.name))
        throw new Error("Duplicate desktop tool schema.");
      this.schemas.set(tool.name, tool.inputSchema);
    }
    for (const name of ["permissions", "inspect_ui"])
      if (!this.schemas.has(name))
        throw new Error(
          "Required desktop tool missing; check selected CLI tool configuration.",
        );
    const permissions = this.schemas.get("permissions")!;
    if (
      permissions.type !== "object" ||
      permissions.additionalProperties !== false ||
      Object.keys(record(permissions.properties ?? {})).length
    )
      throw new Error("Unqualified desktop permission schema.");
    this.ready = true;
  }
  supports(name: string, fields: Record<string, string>): boolean {
    const schema = this.schemas.get(name);
    if (
      !schema ||
      schema.type !== "object" ||
      schema.additionalProperties !== false
    )
      return false;
    const properties = record(schema.properties ?? {});
    return Object.entries(fields).every(([key, type]) => {
      const property = properties[key];
      return (
        property &&
        typeof property === "object" &&
        !Array.isArray(property) &&
        record(property).type === type
      );
    });
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    guard: () => void = () => {},
  ) {
    if (!this.ready || !TOOLS.includes(name) || !this.schemas.has(name))
      throw new Error("Desktop method is not negotiated or allowed.");
    signal?.throwIfAborted();
    bounded(args, 32 * 1024);
    guard();
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: 15000 },
    );
    guard();
    bounded(result);
    const data = record(result);
    if (
      !Array.isArray(data.content) ||
      data.content.length > 512 ||
      (data.isError !== undefined && typeof data.isError !== "boolean")
    )
      throw new Error("Malformed desktop MCP result.");
    for (const block of data.content) {
      const content = record(block);
      if (content.type === "text" && typeof content.text === "string") continue;
      if (content.type === "image") {
        validateDesktopImage(content);
        continue;
      }
      throw new Error("Unsupported desktop MCP content block.");
    }
    if (data._meta !== undefined) record(data._meta);
    return data;
  }
  async close() {
    this.ready = false;
    await this.client.close();
  }
}
export function validateDesktopImage(value: unknown): {
  type: "image";
  mimeType: "image/png";
  data: string;
} {
  const image = record(value);
  if (
    image.type !== "image" ||
    image.mimeType !== "image/png" ||
    typeof image.data !== "string" ||
    image.data.length > Math.ceil(MAX_DESKTOP_IMAGE / 3) * 4
  )
    throw new Error("Unsupported or oversized desktop image.");
  const bytes = Buffer.from(image.data, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_DESKTOP_IMAGE ||
    bytes.toString("base64") !== image.data ||
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Invalid desktop PNG image.");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 4096 ||
    height > 4096 ||
    width * height > 8_000_000
  )
    throw new Error("Desktop image dimensions exceed limits.");
  // Decode only bounded standard non-interlaced RGB/RGBA8 PNGs. Reject embedded text/EXIF
  // and arbitrary ancillary metadata by stripping it before publication. Unknown critical chunks refuse.
  const chunks: Buffer[] = [];
  const sanitized: Buffer[] = [bytes.subarray(0, 8)];
  let offset = 8,
    header = false,
    ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("Truncated desktop PNG.");
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated desktop PNG chunk.");
    const name = bytes.toString("ascii", offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, end - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(end - 4))
      throw new Error("Invalid desktop PNG checksum.");
    if (!header) {
      if (
        name !== "IHDR" ||
        length !== 13 ||
        bytes[offset + 16] !== 8 ||
        ![2, 6].includes(bytes[offset + 17]!) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] !== 0
      )
        throw new Error("Unsupported desktop PNG encoding.");
      header = true;
    } else if (name === "IDAT" && !ended)
      chunks.push(bytes.subarray(offset + 8, end - 4));
    else if (
      name === "IEND" &&
      length === 0 &&
      chunks.length &&
      end === bytes.length
    )
      ended = true;
    else if (!/^[a-z][A-Za-z]{3}$/.test(name) || ended)
      throw new Error("Unsupported desktop PNG critical chunk.");
    if (["IHDR", "IDAT", "IEND"].includes(name))
      sanitized.push(bytes.subarray(offset, end));
    offset = end;
  }
  if (!ended) throw new Error("Incomplete desktop PNG.");
  const channels = bytes[25] === 6 ? 4 : 3,
    stride = 1 + width * channels,
    maximum = stride * height;
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: maximum });
  } catch {
    throw new Error("Invalid or oversized desktop PNG pixels.");
  }
  if (pixels.length !== maximum)
    throw new Error("Invalid desktop PNG pixel length.");
  for (let row = 0; row < height; row++)
    if (pixels[row * stride]! > 4)
      throw new Error("Invalid desktop PNG filter.");
  return {
    type: "image",
    mimeType: "image/png",
    data: Buffer.concat(sanitized).toString("base64"),
  };
}

async function diagnostic(
  command: string,
  args: string[],
  guard: () => void,
  signal?: AbortSignal,
): Promise<string> {
  guard();
  const output = await new Promise<string>((resolve, reject) =>
    execFile(
      command,
      args,
      {
        env: restrictedPeekabooEnvironment(),
        timeout: 10000,
        maxBuffer: 512 * 1024,
        encoding: "utf8",
        signal,
      },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(
                "Signed Peekaboo diagnostic failed. Verify the selected 4.9.0 CLI/app and running GUI socket; no fallback was attempted.",
              ),
            )
          : resolve(command === "/usr/bin/codesign" ? stdout + stderr : stdout),
    ),
  );
  guard();
  return output;
}
async function signedIdentity(
  path: string,
  identifier: string,
  guard: () => void,
) {
  await diagnostic("/usr/bin/codesign", ["--verify", "--strict", path], guard);
  const details = await diagnostic(
    "/usr/bin/codesign",
    ["-d", "--verbose=4", path],
    guard,
  );
  const field = (key: string) =>
    details.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1];
  const team = field("TeamIdentifier"),
    hash = field("CDHash");
  if (
    field("Identifier") !== identifier ||
    !team ||
    !["Y5PE65HELJ", "FWJYW4S8P8"].includes(team) ||
    !/^Authority=Developer ID Application:/m.test(details) ||
    !hash ||
    !/^[a-f0-9]{40,64}$/i.test(hash)
  )
    throw new Error(
      "Select official Developer ID signed Peekaboo CLI/app; development/ad-hoc or unknown signing identity is not qualified.",
    );
  return { team, hash };
}
const releasedRoles = new Set([
  "AXButton",
  "AXTextField",
  "AXTextArea",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXStaticText",
  "AXGroup",
  "AXWindow",
  "AXScrollArea",
  "AXSecureTextField",
]);
function releaseGeneration(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error("Missing lossless native process generation.");
  return value;
}
function releaseInteger(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum)
    throw new Error("Invalid native discovery identifier.");
  return Number(value);
}
/** Official AppCommand+List.swift 4.9.0 JSON, not the incomplete MCP app projection. */
export function releasedApps(
  value: unknown,
  allowedApps: readonly string[],
): ProcessTarget[] {
  bounded(value);
  const result = record(value),
    data = record(result.data);
  if (
    result.success !== true ||
    !Array.isArray(data.apps) ||
    data.apps.length > 1000 ||
    data.count !== data.apps.length ||
    !Array.isArray(data.schema_capabilities) ||
    !data.schema_capabilities.includes("processStartIdentityDecimal")
  )
    throw new Error("Unqualified released app inventory.");
  const apps = data.apps
    .map(record)
    .filter((row) => allowedApps.includes(String(row.bundle_id)))
    .map((row) => ({
      bundleId: String(row.bundle_id),
      pid: releaseInteger(row.pid, 2147483647),
      processStart: releaseGeneration(row.process_start_identity_decimal),
    }));
  if (
    apps.length > 100 ||
    new Set(apps.map((app) => app.pid)).size !== apps.length
  )
    throw new Error("Ambiguous or unbounded allowed app inventory.");
  return apps;
}
/** Bounds are discovery hints only. The signed native observation owns exact geometry validation. */
export function releasedWindows(
  value: unknown,
  app: ProcessTarget,
): WindowTarget[] {
  bounded(value);
  const result = record(value),
    data = record(result.data),
    owner = record(data.target_application_info);
  if (
    result.success !== true ||
    owner.bundle_id !== app.bundleId ||
    owner.pid !== app.pid ||
    !["complete", "partial"].includes(String(data.inventory_completeness)) ||
    !Array.isArray(data.windows) ||
    data.windows.length > 50
  )
    throw new Error("Unqualified window discovery owner or inventory.");
  const windows = data.windows.map((value) => {
    const row = record(value),
      bounds = record(row.bounds);
    if (
      [bounds.x, bounds.y, bounds.width, bounds.height].some(
        (value) =>
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          Math.abs(value) > 100000,
      ) ||
      Number(bounds.width) <= 0 ||
      Number(bounds.height) <= 0
    )
      throw new Error("Invalid discovery geometry.");
    return {
      ...app,
      windowId: releaseInteger(row.window_id, 4294967295),
      bounds: {
        x: Number(bounds.x),
        y: Number(bounds.y),
        width: Number(bounds.width),
        height: Number(bounds.height),
      },
    };
  });
  if (new Set(windows.map((window) => window.windowId)).size !== windows.length)
    throw new Error("Ambiguous window discovery.");
  return windows;
}
/** Released MCP target_receipt/UIElementSummary projection. No title, value, ID or arbitrary metadata escapes. */
export function releasedObservation(
  value: unknown,
  expected: WindowTarget,
  imageRequested = false,
): ProviderObservation {
  bounded(value);
  const result = record(value),
    meta = record(result._meta),
    receipt = record(meta.target_receipt);
  const matches = (value: unknown) => {
    const target = record(value);
    return (
      target.kind === "window" &&
      target.pid === expected.pid &&
      target.window_id === expected.windowId &&
      releaseGeneration(target.process_start_identity_decimal) ===
        expected.processStart
    );
  };
  if (
    result.isError === true ||
    !Array.isArray(result.content) ||
    result.content.some(
      (value) =>
        !["text", ...(imageRequested ? ["image"] : [])].includes(
          String(record(value).type),
        ),
    ) ||
    !matches(receipt) ||
    (meta.target_identity !== undefined && !matches(meta.target_identity)) ||
    typeof meta.snapshot_id !== "string" ||
    !/^ps1_[a-f0-9]{32}$/.test(meta.snapshot_id) ||
    !Array.isArray(meta.ui_elements) ||
    meta.ui_elements.length > 200
  )
    throw new Error("No healthy exact-window producer-bound AX response.");
  // Background read-only inspect normally has no action outcome. If one exists, accept only its
  // canonical zero-dispatch terminal form; partial/lost/cancelled work is never converted into a read.
  const terminal: Record<string, unknown> = {
    state: "confirmed_no_change",
    effect: "confirmed",
    evidence: "verified_no_change",
    dispatch_state: "none",
    mutation_dispatched: false,
    retry_safety: "not_applicable",
    retry_safe: false,
    escalation: "none",
    requires_fresh_observation: false,
    route: "bridge",
  };
  if (
    Object.keys(terminal).some((key) => meta[key] !== undefined) &&
    Object.entries(terminal).some(([key, value]) => meta[key] !== value)
  )
    throw new Error("Observation completion or side effects are uncertain.");
  const ids = new Set<string>();
  const elements = meta.ui_elements.map((value) => {
    const row = record(value);
    if (
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 200 ||
      ids.has(row.id) ||
      typeof row.role !== "string" ||
      (row.ax_role !== undefined &&
        row.ax_role !== null &&
        typeof row.ax_role !== "string") ||
      (row.is_enabled !== undefined &&
        row.is_enabled !== null &&
        typeof row.is_enabled !== "boolean")
    )
      throw new Error("Malformed AX element table.");
    ids.add(row.id);
    if (
      typeof row.is_actionable !== "boolean" ||
      (row.is_value_settable !== undefined &&
        row.is_value_settable !== null &&
        typeof row.is_value_settable !== "boolean")
    )
      throw new Error("Malformed AX actionability.");
    const role =
      typeof row.ax_role === "string" && releasedRoles.has(row.ax_role)
        ? row.ax_role
        : "AXUnknown";
    return {
      id: row.id,
      role,
      enabled: row.is_enabled === true,
      actionable:
        row.is_actionable &&
        role !== "AXUnknown" &&
        role !== "AXSecureTextField",
      valueSettable: row.is_value_settable === true,
      ...(role === "AXSecureTextField" ? { secure: true } : {}),
    };
  });
  const images = result.content
    .map(record)
    .filter((block) => block.type === "image");
  if (
    imageRequested &&
    (images.length !== 1 || elements.some((element) => element.secure))
  )
    throw new Error(
      "Exact screenshot missing or known secure receiver observed.",
    );
  const coordinate =
    meta.coordinate_context === undefined
      ? undefined
      : record(meta.coordinate_context);
  return {
    nativeSnapshot: true,
    target: {
      bundleId: expected.bundleId,
      pid: expected.pid,
      processStart: expected.processStart,
      windowId: expected.windowId,
    },
    snapshotId: meta.snapshot_id,
    fresh: meta.used_cache === false,
    complete: null,
    privacy: elements.some((element) => element.secure) ? "secure" : "unknown",
    surface: "unknown",
    elements,
    ...(imageRequested ? { image: validateDesktopImage(images[0]) } : {}),
    ...(imageRequested && coordinate?.reference_id === meta.snapshot_id
      ? { coordinateReference: meta.snapshot_id }
      : {}),
  };
}

/** Purely injectable I/O seam for fake-wire tests; production constructs it only after signed release checks. */
export class ReleasedPeekabooSession {
  private snapshots = new Map<string, ProviderObservation>();
  constructor(
    private allowedApps: readonly string[],
    private io: {
      command: (args: string[], signal: AbortSignal) => Promise<unknown>;
      call: (
        name: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<unknown>;
      guardHost: (signal: AbortSignal) => Promise<void>;
    },
  ) {}
  private async guarded<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    await this.io.guardHost(signal);
    signal.throwIfAborted();
    const result = await operation();
    signal.throwIfAborted();
    await this.io.guardHost(signal);
    signal.throwIfAborted();
    return result;
  }
  async apps(signal: AbortSignal): Promise<ProcessTarget[]> {
    return this.guarded(signal, async () =>
      releasedApps(
        await this.io.command(
          ["app", "list", "--include-hidden", "--json"],
          signal,
        ),
        this.allowedApps,
      ),
    );
  }
  private async requireApp(app: ProcessTarget, signal: AbortSignal) {
    if (
      !this.allowedApps.includes(app.bundleId) ||
      !(await this.apps(signal)).some(
        (row) =>
          row.bundleId === app.bundleId &&
          row.pid === app.pid &&
          row.processStart === app.processStart,
      )
    )
      throw new Error(
        "Allowed app generation changed; do not reuse discovery references.",
      );
  }
  async windows(
    app: ProcessTarget,
    signal: AbortSignal,
  ): Promise<WindowTarget[]> {
    await this.requireApp(app, signal);
    const windows = await this.guarded(signal, async () =>
      releasedWindows(
        await this.io.command(
          ["window", "list", "--app", app.bundleId, "--json"],
          signal,
        ),
        app,
      ),
    );
    await this.requireApp(app, signal);
    return windows;
  }
  async observe(
    target: WindowTarget,
    image: boolean,
    signal: AbortSignal,
  ): Promise<ProviderObservation> {
    await this.requireApp(target, signal);
    const observation = await this.guarded(signal, async () =>
      releasedObservation(
        await this.io.call(
          image ? "see" : "inspect_ui",
          {
            app_target: target.bundleId,
            window_id: target.windowId,
            fresh: true,
            web_focus: false,
            include_elements: true,
            max_elements: 200,
            max_depth: 30,
            max_children: 200,
            ...(image ? { annotate: false, ocr: false } : {}),
          },
          signal,
        ),
        target,
        image,
      ),
    );
    await this.requireApp(target, signal);
    this.snapshots.clear();
    this.snapshots.set(observation.snapshotId, observation);
    return observation;
  }
  async mutate(input: ProviderMutation, signal: AbortSignal): Promise<unknown> {
    const observation = this.snapshots.get(input.snapshotId);
    if (
      !observation ||
      !observation.fresh ||
      observation.privacy === "secure" ||
      observation.target.bundleId !== input.target.bundleId ||
      observation.target.pid !== input.target.pid ||
      observation.target.processStart !== input.target.processStart ||
      observation.target.windowId !== input.target.windowId
    )
      throw new Error(
        "A fresh current producer snapshot is required; no replay or stale reconstruction.",
      );
    const element = input.elementId
      ? observation.elements.find((row) => row.id === input.elementId)
      : undefined;
    if (
      (input.kind === "type" ||
        input.kind === "scroll" ||
        (input.kind === "click" && !input.coordinates)) &&
      (!element?.enabled || element.secure)
    )
      throw new Error("Current enabled non-secure element required.");
    if (
      input.coordinates &&
      observation.coordinateReference !== input.snapshotId
    )
      throw new Error(
        "Coordinates require a current exact-window image reference.",
      );
    await this.requireApp(input.target, signal);
    const args: Record<string, unknown> = { snapshot: input.snapshotId };
    if (input.kind === "click")
      Object.assign(
        args,
        input.coordinates
          ? {
              coords: `${input.coordinates.x},${input.coordinates.y}`,
              coordinate_space: "image_pixels",
              coordinate_reference: input.snapshotId,
              foreground: false,
              wait_for: 0,
            }
          : { on: input.elementId, foreground: false, wait_for: 0 },
      );
    else if (input.kind === "type")
      Object.assign(args, {
        on: input.elementId,
        text: input.text,
        clear: false,
      });
    else if (input.kind === "key")
      Object.assign(args, {
        keys: [
          input.key === "Shift+Tab"
            ? "shift+Tab"
            : input.key === "Enter"
              ? "Return"
              : input.key,
        ],
        count: input.count ?? 1,
      });
    else
      Object.assign(args, {
        on: input.elementId,
        direction: input.direction,
        amount: input.amount,
        foreground: false,
      });
    // Consume before dispatch, including failure/cancellation. Never reconstruct or replay an uncertain snapshot.
    this.snapshots.clear();
    return this.guarded(signal, () =>
      this.io.call(input.kind === "key" ? "press" : input.kind, args, signal),
    );
  }
}

function releasedHostStatus(value: unknown, socket: string, hash: string) {
  const report = record(value),
    selected = record(record(report.data).selected),
    handshake = record(selected.handshake),
    identity = record(handshake.hostIdentity),
    protocol = record(handshake.negotiatedVersion),
    capabilities = handshake.hostCapabilities,
    enabled = handshake.enabledOperations;
  if (
    report.success !== true ||
    selected.source !== "remote" ||
    selected.socketPath !== socket ||
    handshake.hostKind !== "gui" ||
    identity.bundleIdentifier !== "boo.peekaboo.mac" ||
    identity.bundleShortVersion !== PEEKABOO_VERSION ||
    identity.codeSignatureHash !== hash ||
    protocol.major !== 1 ||
    protocol.minor !== 43 ||
    !Array.isArray(capabilities) ||
    !Array.isArray(enabled) ||
    ![...capabilities, ...enabled].every(
      (value) => typeof value === "string",
    ) ||
    ![
      "hostGenerationIdentity",
      "codeSignatureBuildIdentity",
      "attestedOperationReceipts",
      "producerBoundSnapshotReferences",
    ].every((capability) => capabilities.includes(capability))
  )
    throw new Error("Selected official GUI host is unavailable or mismatched.");
  const generation = releaseGeneration(identity.processStartIdentityDecimal);
  const pid = releaseInteger(identity.processIdentifier, 2147483647);
  return {
    capabilities: capabilities as string[],
    enabled: enabled as string[],
    guardKey: JSON.stringify([
      pid,
      generation,
      hash,
      [...capabilities].sort(),
      [...enabled].sort(),
    ]),
  };
}

export class PeekabooProvider implements DesktopProvider {
  onDisconnect?: () => void;
  private mcp?: PeekabooMcpClient;
  private session?: ReleasedPeekabooSession;
  private capabilities = noDesktopCapabilities();
  async connect(
    config: DesktopConfig,
    guard: () => void,
  ): Promise<ProviderQualification> {
    try {
      if (process.platform !== "darwin")
        throw new Error(
          "Run the backend on the Mac being controlled; this platform cannot qualify Peekaboo.",
        );
      for (const path of [
        config.cliPath,
        config.hostAppPath,
        config.bridgeSocket,
      ])
        if (!isAbsolute(path))
          throw new Error(
            "Select absolute signed CLI, Peekaboo.app and canonical GUI Bridge socket paths.",
          );
      const canonicalSocket = join(
        homedir(),
        "Library/Application Support/Peekaboo/bridge.sock",
      );
      if (config.bridgeSocket !== canonicalSocket)
        throw new Error(
          "Select the canonical Peekaboo GUI bridge.sock; custom/alternate sockets lack the required trusted release policy.",
        );
      guard();
      const cli = await realpath(config.cliPath),
        app = await realpath(config.hostAppPath),
        socket = await lstat(config.bridgeSocket);
      guard();
      if (
        cli.includes(".app/") ||
        !app.endsWith("/Peekaboo.app") ||
        !socket.isSocket() ||
        socket.uid !== process.getuid?.()
      )
        throw new Error(
          "Select the separate official CLI, signed Peekaboo.app and your running GUI host socket.",
        );
      const cliSignature = await signedIdentity(
        cli,
        "boo.peekaboo.peekaboo",
        guard,
      );
      const appSignature = await signedIdentity(app, "boo.peekaboo.mac", guard);
      if (cliSignature.team !== appSignature.team)
        throw new Error(
          "Selected CLI and app must have matching qualified release signing identities.",
        );
      const version = await diagnostic(cli, ["--version"], guard);
      if (!/^Peekaboo 4\.9\.0(?:\s|$)/.test(version))
        throw new Error(
          "Only Peekaboo 4.9.0 is a candidate; install/select a matching signed release yourself. Jelly never updates the host.",
        );
      const plist = JSON.parse(
        await diagnostic(
          "/usr/bin/plutil",
          ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")],
          guard,
        ),
      );
      if (
        plist.CFBundleIdentifier !== "boo.peekaboo.mac" ||
        plist.CFBundleShortVersionString !== PEEKABOO_VERSION
      )
        throw new Error(
          "Selected Peekaboo.app must match candidate CLI 4.9.0.",
        );
      const report = record(
        JSON.parse(
          await diagnostic(
            cli,
            [
              "bridge",
              "status",
              "--bridge-socket",
              config.bridgeSocket,
              "--json",
            ],
            guard,
          ),
        ),
      );
      const host = releasedHostStatus(
        report,
        config.bridgeSocket,
        appSignature.hash,
      );
      guard();
      this.mcp = new PeekabooMcpClient(
        new BoundedPeekabooTransport(cli, [
          "mcp",
          "--bridge-socket",
          config.bridgeSocket,
        ]),
      );
      this.mcp.onDisconnect = () => this.onDisconnect?.();
      await this.mcp.connect(guard);
      const permissionsResult = await this.mcp.call(
        "permissions",
        {},
        undefined,
        guard,
      );
      const meta = record(permissionsResult._meta);
      const known = meta.permission_snapshot_available === true;
      const permission = (key: string) =>
        known && typeof meta[key] === "boolean" ? (meta[key] as boolean) : null;
      const permissions: DesktopPermissions = {
        accessibility: permission("accessibility"),
        screenRecording: permission("screen_recording"),
        syntheticInput: permission("event_synthesizing"),
      };
      if (permissions.accessibility !== true) {
        await this.close();
        return {
          qualified: false,
          reason:
            "The selected Peekaboo host needs Accessibility permission. Grant it to Peekaboo in macOS Settings, then reconnect; do not grant Bun/Node access.",
          permissions,
        };
      }
      const mcp = this.mcp;
      const has = (capability: string) =>
        host.capabilities.includes(capability);
      const operation = (name: string) => host.enabled.includes(name);
      const observe = mcp.supports("inspect_ui", {
        app_target: "string",
        window_id: "integer",
        fresh: "boolean",
        include_elements: "boolean",
      });
      if (!observe)
        throw new Error("Released exact-window AX schema is unavailable.");
      this.capabilities = {
        observe,
        images:
          permissions.screenRecording === true &&
          mcp.supports("see", {
            app_target: "string",
            window_id: "integer",
            include_elements: "boolean",
          }) &&
          operation("desktopObservation"),
        click:
          has("processGenerationBoundElementMutations") &&
          mcp.supports("click", {
            on: "string",
            snapshot: "string",
            foreground: "boolean",
          }) &&
          (operation("performAction") || operation("exactWindowTargetedClick")),
        type:
          permissions.syntheticInput === true &&
          mcp.supports("type", {
            on: "string",
            snapshot: "string",
            text: "string",
          }) &&
          operation("exactWindowTargetedTypeActions"),
        key:
          permissions.syntheticInput === true &&
          mcp.supports("press", {
            keys: "array",
            snapshot: "string",
            count: "integer",
          }) &&
          operation("exactWindowTargetedHotkey"),
        scroll:
          has("requestPinnedExactWindowScrollReceipt") &&
          mcp.supports("scroll", {
            on: "string",
            snapshot: "string",
            direction: "string",
          }) &&
          operation("targetedScroll"),
        menu: false,
        foreground: false,
      };
      this.session = new ReleasedPeekabooSession([...config.allowedApps], {
        command: async (args, signal) =>
          JSON.parse(
            await diagnostic(
              cli,
              [...args, "--bridge-socket", config.bridgeSocket],
              guard,
              signal,
            ),
          ),
        call: (name, args, signal) => mcp.call(name, args, signal, guard),
        guardHost: async (signal) => {
          const current = releasedHostStatus(
            JSON.parse(
              await diagnostic(
                cli,
                [
                  "bridge",
                  "status",
                  "--bridge-socket",
                  config.bridgeSocket,
                  "--json",
                ],
                guard,
                signal,
              ),
            ),
            config.bridgeSocket,
            appSignature.hash,
          );
          if (current.guardKey !== host.guardKey)
            throw new Error("Selected host changed; reconnect without replay.");
        },
      });
      return {
        qualified: true,
        version: PEEKABOO_VERSION,
        // This is the retained MCP-client epoch, NOT a claim that a separate status process attested its connection.
        generation: `native-mcp-${randomUUID()}`,
        identity: `signed-cli:${cliSignature.hash}`,
        capabilities: { ...this.capabilities },
        permissions,
        contracts: {
          nativePinnedConnection: true,
          discoveryOnlyInventory: true,
          exactTargetReceipts: true,
        },
      };
    } catch (error) {
      await this.close();
      // External SDK/process errors can contain arbitrary host content; never forward even their messages.
      return {
        qualified: false,
        reason:
          "Peekaboo qualification failed. Verify separate official Developer ID signed CLI and Peekaboo.app, both 4.9.0 with matching release team, canonical running GUI bridge.sock and host-owned permissions. Custom sockets, other versions and local fallback are refused. Grant missing permissions to Peekaboo, not Bun/Node; no vendor rebuild is required.",
      };
    }
  }
  async apps(signal: AbortSignal): Promise<ProcessTarget[]> {
    if (!this.session) throw new Error(QUALIFICATION_BLOCKER);
    return this.session.apps(signal);
  }
  async windows(
    app: ProcessTarget,
    signal: AbortSignal,
  ): Promise<WindowTarget[]> {
    if (!this.session) throw new Error(QUALIFICATION_BLOCKER);
    return this.session.windows(app, signal);
  }
  async observe(
    target: WindowTarget,
    image: boolean,
    signal: AbortSignal,
  ): Promise<ProviderObservation> {
    if (
      !this.session ||
      !this.capabilities.observe ||
      (image && !this.capabilities.images)
    )
      throw new Error(QUALIFICATION_BLOCKER);
    return this.session.observe(target, image, signal);
  }
  async mutate(input: ProviderMutation, signal: AbortSignal): Promise<unknown> {
    if (!this.session || !this.capabilities[input.kind])
      throw new Error("Selected host does not support this scoped action.");
    return this.session.mutate(input, signal);
  }
  async close() {
    const mcp = this.mcp;
    this.mcp = undefined;
    this.session = undefined;
    this.capabilities = noDesktopCapabilities();
    await mcp?.close();
  }
}
