import { randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_DESKTOP_CONFIG,
  type DesktopConfig,
  type DesktopOwner,
  type DesktopStatus,
} from "../shared/desktop";
import { DesktopLease, defaultDesktopLeaseRoot } from "./desktop-lease";
import {
  PeekabooProvider,
  bounded,
  record,
  noDesktopCapabilities,
  unknownDesktopPermissions,
  validateDesktopImage,
  type DesktopProvider,
  type DesktopProviderFactory,
  type ProviderQualification,
  type ProcessTarget,
  type WindowTarget,
  type SnapshotTarget,
  type ProviderObservation,
  type ProviderElement,
} from "./peekaboo";

const UNSAFE =
  "Desktop host completion is unknown or effects need recovery. Private handoff is blocked. Do not replay input or enter credentials. Peekaboo 4.9.0 has no qualifying drain/recovery API; retain quarantine until qualified operator recovery.";
const UNSUPPORTED =
  "Foreground requires an explicit expiring run grant. Menu input cannot consume a caller-generation/snapshot reference in the released MCP schema; use current background element actions instead. Do not bypass these boundaries.";
const REF_LIFETIME = 15000;
const roles = new Set([
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
]);
const keys = new Set([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "Space",
]);
export function desktopAppAllowed(bundle: string): boolean {
  // Exact grants are necessary but never override excluded browser/shell/security/control surfaces.
  return (
    /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(bundle) &&
    bundle.length <= 200 &&
    !/(?:browser|chrome|chromium|firefox|safari|webkit|brave|opera|vivaldi|torproject|edge|arc\.browser|terminal|iterm|warp|wezterm|alacritty|kitty|shell|password|1password|lastpass|bitwarden|keepass|dashlane|keychain|security|systempreferences|systemsettings|settings|auth|login|jelly|peekaboo|boo\.peekaboo|remote.?desktop|screen.?sharing|automator|scripteditor|shortcuts|raycast|alfred|hammerspoon|bettertouchtool|karabiner|code|vscode|cursor|jetbrains|com\.apple\.finder)/i.test(
      bundle,
    )
  );
}
function configInput(input: unknown, previous: DesktopConfig): DesktopConfig {
  const data = record(input);
  if (
    Object.keys(data).some((key) => !Object.hasOwn(DEFAULT_DESKTOP_CONFIG, key))
  )
    throw new Error("Unknown desktop configuration field.");
  const config = { ...previous, ...data } as DesktopConfig;
  if (
    typeof config.enabled !== "boolean" ||
    typeof config.captureConsent !== "boolean" ||
    !Array.isArray(config.allowedApps) ||
    config.allowedApps.length > 32 ||
    config.allowedApps.some(
      (app) => typeof app !== "string" || !desktopAppAllowed(app),
    ) ||
    new Set(config.allowedApps).size !== config.allowedApps.length
  )
    throw new Error(
      "Desktop configuration requires explicit unique allowed native bundle IDs; browsers, shells, credentials, security and control apps are excluded.",
    );
  for (const path of [config.cliPath, config.hostAppPath, config.bridgeSocket])
    if (
      typeof path !== "string" ||
      path.length > 4096 ||
      path.includes("\0") ||
      (path !== "" && !isAbsolute(path))
    )
      throw new Error("Desktop paths must be absolute operator selections.");
  if (
    config.enabled &&
    (!config.cliPath ||
      !config.hostAppPath ||
      !config.bridgeSocket ||
      !config.allowedApps.length)
  )
    throw new Error(
      "Choose the signed CLI/app, explicit GUI socket and allowed native apps before enabling desktop.",
    );
  return structuredClone(config);
}
function processTarget(value: unknown): ProcessTarget {
  const target = record(value);
  if (
    typeof target.bundleId !== "string" ||
    !desktopAppAllowed(target.bundleId) ||
    !Number.isInteger(target.pid) ||
    Number(target.pid) < 1 ||
    Number(target.pid) > 2147483647 ||
    typeof target.processStart !== "string" ||
    !/^[1-9]\d{0,19}$/.test(target.processStart)
  )
    throw new Error(
      "Unproved desktop process generation; inventory cannot grant authority.",
    );
  return {
    bundleId: target.bundleId,
    pid: target.pid as number,
    processStart: target.processStart,
  };
}
function windowTarget(value: unknown): WindowTarget {
  const data = record(value),
    target = processTarget(data),
    bounds = record(data.bounds);
  if (
    !Number.isInteger(data.windowId) ||
    Number(data.windowId) < 1 ||
    Number(data.windowId) > 4294967295 ||
    [bounds.x, bounds.y, bounds.width, bounds.height].some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        Math.abs(value) > 100000,
    ) ||
    Number(bounds.width) <= 0 ||
    Number(bounds.height) <= 0
  )
    throw new Error("Unproved exact desktop window/geometry.");
  return {
    ...target,
    windowId: data.windowId as number,
    bounds: {
      x: bounds.x as number,
      y: bounds.y as number,
      width: bounds.width as number,
      height: bounds.height as number,
    },
  };
}
function sameProcess(a: ProcessTarget, b: ProcessTarget) {
  return (
    a.bundleId === b.bundleId &&
    a.pid === b.pid &&
    a.processStart === b.processStart
  );
}
function sameWindow(a: WindowTarget, b: WindowTarget) {
  return (
    sameProcess(a, b) &&
    a.windowId === b.windowId &&
    ["x", "y", "width", "height"].every(
      (key) =>
        a.bounds[key as keyof typeof a.bounds] ===
        b.bounds[key as keyof typeof b.bounds],
    )
  );
}
function exactArguments(
  input: unknown,
  allowed: string[],
  required: string[] = [],
): Record<string, unknown> {
  const data = record(input);
  if (
    Object.keys(data).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(data, key))
  )
    throw new Error(
      "Invalid desktop arguments; use only opaque run-bound references and the documented fields.",
    );
  return data;
}
function ref(value: unknown) {
  if (typeof value !== "string" || value.length > 100)
    throw new Error("A current opaque desktop reference is required.");
  return value;
}

/** Public MCP state vocabulary/consistency from DesktopActionOutcome.swift v4.9.0.
 * Only closed safety fields are returned; provider prose and target/value metadata never reach the model. */
export function desktopMutationOutcome(
  value: unknown,
  expected: SnapshotTarget,
  nativeCompleted = false,
) {
  bounded(value);
  const result = record(value),
    meta = record(result._meta);
  if (result.isError !== undefined && typeof result.isError !== "boolean")
    throw new Error("Malformed desktop mutation result.");
  const states: Record<string, [string, string[], string, string, string]> = {
    confirmed_change: [
      "confirmed",
      ["verified_change"],
      "dispatched",
      "not_applicable",
      "none",
    ],
    confirmed_no_change: [
      "confirmed",
      ["verified_no_change"],
      "none",
      "not_applicable",
      "none",
    ],
    partial: [
      "partial",
      ["primary_change_verified_cleanup_failed"],
      "dispatched",
      "unsafe",
      "recover_side_effect",
    ],
    dispatched_unverified: [
      "unverifiable",
      ["delivery_accepted", "operation_still_running"],
      "dispatched",
      "unsafe",
      "observe_before_retry",
    ],
    suspected_noop: [
      "suspected_noop",
      ["observed_no_change"],
      "dispatched",
      "safe",
      "refresh_target",
    ],
    refused: ["refused", ["request_refused"], "none", "safe", ""],
    indeterminate: [
      "unverifiable",
      ["response_lost", "completion_unknown"],
      "may_have_dispatched",
      "unsafe",
      "observe_before_retry",
    ],
  };
  const state = typeof meta.state === "string" ? meta.state : "",
    canonical = states[state];
  const refusals: Record<string, string> = {
    invalid_request: "correct_request",
    permission_denied: "grant_permission",
    target_unavailable: "refresh_target",
    transport_session_unavailable: "reconnect_session",
    request_cancelled: "none",
    runtime_incompatible: "update_runtime",
    foreground_consent_required: "correct_request",
    operation_unsupported: "correct_request",
  };
  if (
    !canonical ||
    (state === "refused" &&
      !Object.hasOwn(refusals, String(meta.refusal_reason))) ||
    meta.route !== "bridge" ||
    meta.effect !== canonical[0] ||
    !canonical[1].includes(String(meta.evidence)) ||
    meta.dispatch_state !== canonical[2] ||
    meta.retry_safety !== canonical[3] ||
    meta.escalation !==
      (state === "refused"
        ? refusals[String(meta.refusal_reason)]
        : canonical[4]) ||
    (state !== "refused" && meta.refusal_reason !== undefined) ||
    meta.mutation_dispatched !== (canonical[2] !== "none") ||
    meta.retry_safe !== (canonical[3] === "safe") ||
    meta.requires_fresh_observation !==
      (canonical[2] !== "none" && canonical[4] === "observe_before_retry")
  )
    throw new Error(
      "Unknown or contradictory desktop effect evidence; completion cannot be claimed.",
    );
  if (
    meta.dispatched_unit_count !== undefined &&
    (!Number.isSafeInteger(meta.dispatched_unit_count) ||
      Number(meta.dispatched_unit_count) < 1 ||
      canonical[2] === "none")
  )
    throw new Error("Invalid desktop dispatch count.");
  const delivery =
    meta.delivery_mechanism !== undefined || meta.delivery_mode !== undefined;
  if (
    delivery &&
    (meta.delivery_mode !== "background" ||
      ![
        "accessibility_action",
        "accessibility_value",
        "process_targeted_events",
        "window_targeted_events",
        ...(nativeCompleted ? ["native_framework", "composite"] : []),
      ].includes(String(meta.delivery_mechanism)))
  )
    throw new Error("Unqualified desktop delivery route.");
  if (
    (["confirmed_no_change", "refused"].includes(state) && delivery) ||
    (!["confirmed_no_change", "refused", "indeterminate"].includes(state) &&
      !delivery)
  )
    throw new Error("Missing or contradictory desktop delivery evidence.");
  const identity =
    meta.target_identity === undefined
      ? undefined
      : record(meta.target_identity);
  const receipt =
    meta.target_receipt === undefined ? undefined : record(meta.target_receipt);
  for (const target of [identity, receipt])
    if (
      target &&
      (target.pid !== expected.pid ||
        target.process_start_identity_decimal !== expected.processStart ||
        target.window_id !== expected.windowId)
    )
      throw new Error("Desktop action target generation mismatch.");
  if (identity && identity.kind !== "window")
    throw new Error("Desktop result is not exact-window bound.");
  if (canonical[2] !== "none" && !identity && !receipt)
    throw new Error("Desktop dispatch lacks exact target receipt.");
  return {
    state,
    effect: canonical[0],
    evidence: String(meta.evidence),
    dispatch: canonical[2],
    retrySafety: canonical[3],
    escalation: String(meta.escalation),
    requiresFreshObservation: meta.requires_fresh_observation as boolean,
    ...(meta.dispatched_unit_count !== undefined
      ? { dispatchedUnitCount: meta.dispatched_unit_count as number }
      : {}),
    ...(state === "refused"
      ? { refusalReason: String(meta.refusal_reason) }
      : {}),
    // Semantic delivery acceptance/partial effects are not host/application drain proof.
    unsafe:
      !["confirmed_change", "confirmed_no_change", "refused"].includes(state) &&
      !(
        nativeCompleted &&
        (state === "suspected_noop" ||
          (state === "dispatched_unverified" &&
            meta.evidence === "delivery_accepted"))
      ),
  };
}

type Reference =
  | { kind: "app"; target: ProcessTarget; epoch: number }
  | { kind: "window"; target: WindowTarget; epoch: number }
  | {
      kind: "observation";
      observation: ProviderObservation;
      created: number;
      epoch: number;
    }
  | {
      kind: "element";
      observationRef: string;
      element: ProviderElement;
      epoch: number;
    };
export interface DesktopSessionsOptions {
  isRunActive: (agentId: string, runId: string) => boolean;
  notify: () => void;
  providerFactory?: DesktopProviderFactory;
  leaseRoot?: string;
  canAdmit?: () => boolean;
  platform?: string;
}
export class DesktopSessions {
  private config: DesktopConfig = structuredClone(DEFAULT_DESKTOP_CONFIG);
  private connection: DesktopStatus["connection"] = "disabled";
  private control: DesktopStatus["control"] = "stopped";
  private reason: string | null = null;
  private owner: DesktopOwner | null = null;
  private target: DesktopStatus["target"] = null;
  private capabilities = noDesktopCapabilities();
  private nativeSnapshots = false;
  private permissions = unknownDesktopPermissions();
  private host: DesktopStatus["host"] = null;
  private provider?: DesktopProvider;
  private lease?: DesktopLease;
  private privateControl = false;
  private privateSafe = false;
  private privateLease?: DesktopLease;
  private privateTransition?: Promise<DesktopStatus>;
  private privateReleasing = false;
  private refs = new Map<string, Reference>();
  private epoch = 0;
  private busy = false;
  private connecting = false;
  private configuring = false;
  private settling = false;
  private closed = false;
  private inFlight?: AbortController;
  private unsafePersistence: Promise<void> = Promise.resolve();
  private configPath: string;
  constructor(
    private dataDir: string,
    private options: DesktopSessionsOptions,
  ) {
    this.configPath = join(dataDir, "desktop.json");
    try {
      const file = lstatSync(this.configPath);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.uid !== process.getuid?.() ||
        file.mode & 0o077 ||
        file.size > 32768
      )
        throw new Error("Unsafe desktop config file.");
      this.config = configInput(
        JSON.parse(readFileSync(this.configPath, "utf8")),
        this.config,
      );
      this.connection = this.config.enabled ? "disconnected" : "disabled";
      this.control = this.config.enabled ? "paused" : "stopped";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.connection = "blocked";
        this.reason =
          "Desktop config is invalid or not owner-only. Repair/remove desktop.json through operator setup; no desktop activity was enabled.";
      }
    }
  }
  status(): DesktopStatus {
    return structuredClone({
      config: this.config,
      platformSupported:
        (this.options.platform ?? process.platform) === "darwin",
      connection: this.connection,
      reason: this.reason,
      control: this.control,
      privateSafe: this.privateSafe,
      owner: this.owner,
      target: this.target,
      foregroundExpiresAt: null,
      capabilities: this.capabilities,
      host: this.host,
      permissions: this.permissions,
    });
  }
  private notify() {
    this.options.notify();
  }
  private admission() {
    if (
      this.closed ||
      this.privateControl ||
      this.options.canAdmit?.() === false
    )
      throw new Error(
        "Desktop admission is closed during private control/shutdown. Explicit handback is required.",
      );
  }
  private invalidate() {
    this.epoch++;
    this.refs.clear();
    this.target = null;
  }
  private unsafe() {
    this.privateSafe = false;
    if (this.control === "unsafe") return;
    this.control = "unsafe";
    this.reason = UNSAFE;
    this.invalidate();
    this.unsafePersistence = this.lease?.quarantine() ?? Promise.resolve();
    this.notify();
  }
  private run(agentId: string, runId: string) {
    this.admission();
    if (!this.options.isRunActive(agentId, runId))
      throw new Error("Desktop references belong to an inactive/foreign run.");
    if (
      this.owner &&
      (this.owner.agentId !== agentId || this.owner.runId !== runId)
    )
      throw new Error(
        "Desktop busy: another run owns the full observe/act/verify lease.",
      );
  }
  private ready(agentId: string, runId: string) {
    this.run(agentId, runId);
    if (this.settling)
      throw new Error(
        "Desktop settlement is in progress; admission is closed.",
      );
    if (this.control !== "active")
      throw new Error(
        this.control === "unsafe"
          ? UNSAFE
          : "Desktop is paused/stopped; the operator must explicitly resume this live run.",
      );
    if (
      !this.config.enabled ||
      this.connection !== "ready" ||
      !this.provider ||
      !this.host
    )
      throw new Error(
        this.reason ??
          "Desktop is not qualified/connected. Configure the signed release and exact GUI socket through Settings.",
      );
  }
  async configure(input: unknown): Promise<DesktopStatus> {
    if (
      this.closed ||
      this.settling ||
      this.configuring ||
      this.connecting ||
      this.busy ||
      this.owner ||
      this.control === "unsafe"
    )
      throw new Error(
        this.control === "unsafe"
          ? UNSAFE
          : "Settle the owning desktop run before reconfiguring.",
      );
    const config = configInput(input, this.config);
    if (config.enabled) this.admission();
    this.configuring = true;
    const temp = join(this.dataDir, `desktop.${randomUUID()}.tmp`);
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const file = await open(
        temp,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(config));
        await file.sync();
      } finally {
        await file.close();
      }
      if (config.enabled) this.admission();
      await this.provider?.close();
      if (config.enabled) this.admission();
      await rename(temp, this.configPath);
      // A private boundary may close during filesystem commit; persist only the safe disabled state.
      if (
        config.enabled &&
        (this.closed || this.options.canAdmit?.() === false)
      ) {
        config.enabled = false;
        const disabled = await open(
          this.configPath,
          constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
        );
        try {
          await disabled.writeFile(JSON.stringify(config));
          await disabled.sync();
        } finally {
          await disabled.close();
        }
      }
      this.provider = undefined;
      this.host = null;
      this.capabilities = noDesktopCapabilities();
      this.permissions = unknownDesktopPermissions();
      this.config = config;
      this.connection = config.enabled ? "disconnected" : "disabled";
      this.control = config.enabled ? "paused" : "stopped";
      this.reason = null;
      this.invalidate();
      this.notify();
      return this.status();
    } finally {
      this.configuring = false;
      await rm(temp, { force: true });
    }
  }
  async connect(): Promise<DesktopStatus> {
    this.admission();
    if (!this.config.enabled) return this.status();
    if (this.control === "unsafe") throw new Error(UNSAFE);
    if (
      this.owner ||
      this.settling ||
      this.busy ||
      this.configuring ||
      this.connecting
    )
      throw new Error(
        "Desktop busy; settle the owning run before reconnecting.",
      );
    if (!this.status().platformSupported) {
      this.connection = "blocked";
      this.reason =
        "Run the Jelly backend on the same Mac; desktop control is unavailable on this platform.";
      this.notify();
      return this.status();
    }
    this.connecting = true;
    this.connection = "connecting";
    // Qualification belongs to this connection attempt, never the previous host.
    this.host = null;
    this.capabilities = noDesktopCapabilities();
    this.permissions = unknownDesktopPermissions();
    this.invalidate();
    const epoch = this.epoch;
    this.notify();
    const guard = () => {
      this.admission();
      if (this.epoch !== epoch)
        throw new Error(
          "Desktop connection revoked; explicit resume is required.",
        );
    };
    let provider: DesktopProvider | undefined;
    try {
      provider = (
        this.options.providerFactory ?? (() => new PeekabooProvider())
      )(structuredClone(this.config));
      const selectedProvider = provider;
      provider.onDisconnect = () => {
        if (
          this.provider !== selectedProvider ||
          this.closed ||
          this.settling ||
          this.configuring ||
          this.connecting
        )
          return;
        this.connection = "blocked";
        this.capabilities = noDesktopCapabilities();
        this.host = null;
        this.invalidate();
        if (this.inFlight) {
          this.unsafe();
          this.inFlight.abort();
        } else {
          this.control = "paused";
          this.reason =
            "Desktop listener disconnected/replaced. Reconnect and requalify the exact signed host; old references cannot be reused.";
          this.notify();
        }
      };
      await this.provider?.close();
      guard();
      this.provider = provider;
      guard();
      const qualification = await provider.connect(
        structuredClone(this.config),
        guard,
      );
      guard();
      bounded(qualification, 16384);
      if (qualification.qualified !== true) {
        this.connection = "blocked";
        this.reason =
          typeof qualification.reason === "string" &&
          qualification.reason.length <= 2000
            ? qualification.reason
            : "Desktop qualification is incomplete; repair the selected signed host.";
        this.permissions =
          qualification.permissions ?? unknownDesktopPermissions();
      } else {
        this.acceptQualification(qualification);
        this.connection = "ready";
        this.reason = null;
      }
      this.notify();
      return this.status();
    } catch {
      await provider?.close().catch(() => {});
      this.provider = undefined;
      this.connection = "blocked";
      this.reason =
        "Desktop connection qualification failed or was revoked. Explicitly reconnect after private handback; no host drain is implied.";
      this.capabilities = noDesktopCapabilities();
      this.host = null;
      this.notify();
      return this.status();
    } finally {
      this.connecting = false;
    }
  }
  private acceptQualification(
    value: Extract<ProviderQualification, { qualified: true }>,
  ) {
    const contracts = record(value.contracts),
      caps = record(value.capabilities),
      permissions = record(value.permissions);
    if (
      value.version !== "4.9.0" ||
      typeof value.generation !== "string" ||
      !value.generation ||
      value.generation.length > 200 ||
      typeof value.identity !== "string" ||
      !value.identity ||
      value.identity.length > 200 ||
      !(
        (contracts.connectionBoundIdentity === true &&
          contracts.generationBoundInventory === true) ||
        (contracts.nativePinnedConnection === true &&
          contracts.discoveryOnlyInventory === true)
      ) ||
      contracts.exactTargetReceipts !== true ||
      Object.keys(noDesktopCapabilities()).some(
        (key) => typeof caps[key] !== "boolean",
      ) ||
      permissions.accessibility !== true ||
      Object.keys(unknownDesktopPermissions()).some(
        (key) =>
          permissions[key] !== null && typeof permissions[key] !== "boolean",
      )
    )
      throw new Error("Desktop qualification evidence is incomplete.");
    this.nativeSnapshots = contracts.nativePinnedConnection === true;
    this.capabilities = {
      ...value.capabilities,
      images:
        value.capabilities.images && value.permissions.screenRecording === true,
      type:
        value.capabilities.type && value.permissions.syntheticInput === true,
      key: value.capabilities.key && value.permissions.syntheticInput === true,
      scroll: this.nativeSnapshots && value.capabilities.scroll,
      menu: false,
      foreground: false,
    };
    this.host = {
      version: value.version,
      generation: value.generation,
      identity: value.identity,
    };
    this.permissions = { ...value.permissions };
  }
  async pause(): Promise<DesktopStatus> {
    this.invalidate();
    if (this.control === "unsafe") {
      await this.unsafePersistence;
      return this.status();
    }
    if (this.inFlight) {
      this.unsafe();
      this.inFlight.abort();
      await this.unsafePersistence;
    } else {
      this.control =
        this.privateControl && !this.privateSafe ? "draining" : "paused";
      this.notify();
    }
    return this.status();
  }
  /** Private-safe state requires exclusive cross-instance ownership, even when
   * this instance has never admitted a desktop call. Keep that exclusion across
   * run settlement and expiry until an explicit operator handback. */
  async pauseForPrivacy(): Promise<DesktopStatus> {
    if (this.privateTransition) return this.privateTransition;
    this.privateControl = true;
    this.privateSafe = false;
    this.control = this.control === "unsafe" ? "unsafe" : "draining";
    this.notify();
    if (this.privateReleasing) {
      this.control = "unsafe";
      this.reason =
        "A newer private takeover raced handback. Exclusion is unconfirmed; do not enter credentials.";
      this.notify();
      return this.status();
    }
    const transition = (async () => {
      await this.pause();
      if (this.control === "unsafe") return this.status();
      if (!this.status().platformSupported) {
        this.privateSafe = true;
        this.control = "paused";
        this.notify();
        return this.status();
      }
      if (this.lease) {
        await this.lease.assertOwned();
      } else if (!this.privateLease) {
        const lease = new DesktopLease(
          this.options.leaseRoot ?? defaultDesktopLeaseRoot(),
          { agentId: "private-control", runId: randomUUID() },
        );
        await lease.acquire();
        this.privateLease = lease;
      }
      // A newer stop/loss cannot be undone by a late filesystem acknowledgement.
      if (this.status().control === "unsafe" || this.closed)
        return this.status();
      this.privateSafe = true;
      this.control = "paused";
      this.notify();
      return this.status();
    })().catch(() => {
      this.privateSafe = false;
      this.control = "unsafe";
      this.reason =
        "Cross-instance private exclusion could not be established. Another or unknown desktop owner may still be active. Do not enter credentials or reclaim from PID/age evidence.";
      this.invalidate();
      this.notify();
      return this.status();
    });
    this.privateTransition = transition;
    try {
      return await transition;
    } finally {
      if (this.privateTransition === transition)
        this.privateTransition = undefined;
    }
  }
  async releasePrivateControl(): Promise<void> {
    if (
      this.control === "unsafe" ||
      this.privateTransition ||
      this.privateReleasing
    )
      throw new Error(UNSAFE);
    this.privateReleasing = true;
    this.privateSafe = false;
    this.notify();
    try {
      await this.privateLease?.release();
      this.privateLease = undefined;
      if (this.status().control === "unsafe") throw new Error(UNSAFE);
      this.privateControl = false;
      this.invalidate();
      this.notify();
    } finally {
      this.privateReleasing = false;
    }
    // This removes a human reservation only; it never resumes automation.
  }
  async pauseForRun(agentId: string, runId: string): Promise<DesktopStatus> {
    this.run(agentId, runId);
    return this.pauseForPrivacy();
  }
  async stop(): Promise<DesktopStatus> {
    await this.pause();
    if (this.control !== "unsafe") {
      this.control = "stopped";
      this.notify();
    }
    return this.status();
  }
  async resume(agentId: string, runId: string): Promise<DesktopStatus> {
    this.run(agentId, runId);
    if (this.control === "unsafe") throw new Error(UNSAFE);
    if (
      this.settling ||
      this.busy ||
      this.connecting ||
      this.configuring ||
      !this.config.enabled ||
      this.connection !== "ready"
    )
      throw new Error(
        this.reason ?? "Connect and qualify desktop before explicit resume.",
      );
    const epoch = this.epoch;
    if (this.lease) await this.lease.assertOwned();
    this.run(agentId, runId);
    if (
      epoch !== this.epoch ||
      this.status().control === "unsafe" ||
      this.settling ||
      this.busy ||
      this.connecting ||
      this.configuring ||
      !this.config.enabled ||
      this.connection !== "ready"
    )
      throw new Error(
        "Desktop resume was revoked by a newer pause, stop or connection transition.",
      );
    this.admission();
    this.invalidate();
    this.control = "active";
    this.notify();
    return this.status();
  }
  async grantForeground(
    agentId: string,
    runId: string,
    _durationMs: number,
  ): Promise<DesktopStatus> {
    this.run(agentId, runId);
    throw new Error(UNSUPPORTED);
  }
  invalidateRun(agentId: string, runId: string): void {
    if (this.owner?.agentId !== agentId || this.owner.runId !== runId) return;
    this.invalidate();
    if (this.inFlight) {
      this.unsafe();
      this.inFlight.abort();
    }
    this.notify();
  }
  async settle(agentId: string, runId: string): Promise<void> {
    if (this.owner?.agentId !== agentId || this.owner.runId !== runId) return;
    if (this.settling)
      throw new Error("Desktop settlement is already in progress.");
    this.settling = true;
    try {
      await this.pause();
      if (this.control === "unsafe") throw new Error(UNSAFE);
      if (this.busy)
        throw new Error(
          "Desktop is still settling; do not claim a safe private handoff.",
        );
      // Keep exclusion through client closure; proxy closure is not used as completion evidence.
      await this.provider?.close();
      this.provider = undefined;
      if (this.privateControl) {
        // Convert old run authority into a cleanup-only human reservation.
        this.privateLease = this.lease;
        this.lease = undefined;
      } else {
        await this.lease?.release();
        this.lease = undefined;
      }
      this.owner = null;
      this.host = null;
      this.capabilities = noDesktopCapabilities();
      this.connection = this.config.enabled ? "disconnected" : "disabled";
      this.control = this.privateControl ? "paused" : "stopped";
      this.notify();
    } finally {
      this.settling = false;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.pause();
    await this.provider?.close();
    this.provider = undefined;
    if (this.control !== "unsafe" && !this.busy && !this.privateControl) {
      await this.lease?.release();
      this.lease = undefined;
      this.owner = null;
    }
    this.connection = this.config.enabled ? "disconnected" : "disabled";
    this.host = null;
    this.capabilities = noDesktopCapabilities();
    this.notify();
  }
  private add(reference: Reference) {
    if (this.refs.size >= 600)
      throw new Error("Desktop reference limit reached; observe again.");
    const id = randomUUID();
    this.refs.set(id, reference);
    return id;
  }
  private lookup(id: unknown, kind: Reference["kind"]) {
    const reference = this.refs.get(ref(id));
    if (!reference || reference.kind !== kind || reference.epoch !== this.epoch)
      throw new Error(
        "Stale or foreign desktop reference; request a new exact-window observation.",
      );
    return reference;
  }
  private allowed(target: ProcessTarget) {
    if (
      !this.config.allowedApps.includes(target.bundleId) ||
      !desktopAppAllowed(target.bundleId)
    )
      throw new Error("Desktop target app is not explicitly allowed.");
  }
  private async call<T>(
    agentId: string,
    runId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    validate: (value: T) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    this.ready(agentId, runId);
    signal?.throwIfAborted();
    const epoch = this.epoch;
    await this.lease!.assertOwned();
    this.ready(agentId, runId);
    signal?.throwIfAborted();
    if (epoch !== this.epoch)
      throw new Error(
        "Desktop reference revoked before dispatch; obtain a fresh observation.",
      );
    const controller = new AbortController();
    this.inFlight = controller;
    let remove = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => {
        this.unsafe();
        controller.abort();
        reject(new Error(UNSAFE));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const internal = () => reject(new Error(UNSAFE));
      controller.signal.addEventListener("abort", internal, { once: true });
      const timeout = setTimeout(abort, 15000);
      remove = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", internal);
      };
    });
    try {
      // Recheck at the actual dispatch point, never reuse admission from before an await.
      this.ready(agentId, runId);
      signal?.throwIfAborted();
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.ready(agentId, runId);
          signal?.throwIfAborted();
          if (epoch !== this.epoch)
            throw new Error("Desktop authority revoked before dispatch.");
          return operation(controller.signal);
        }),
        cancelled,
      ]);
      bounded(result);
      const validated = validate(result);
      if (controller.signal.aborted || epoch !== this.epoch)
        throw new Error(UNSAFE);
      this.ready(agentId, runId);
      return validated;
    } catch {
      // A timeout, SDK exception, malformed response or revoked late response proves no host drain.
      this.unsafe();
      controller.abort();
      await this.unsafePersistence;
      throw new Error(UNSAFE);
    } finally {
      remove();
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }
  async action(
    agentId: string,
    runId: string,
    method:
      | "apps"
      | "windows"
      | "observe"
      | "click"
      | "type"
      | "key"
      | "scroll"
      | "menu",
    input: unknown = {},
    signal?: AbortSignal,
  ): Promise<{
    data: unknown;
    image?: { type: "image"; mimeType: "image/png"; data: string };
  }> {
    this.ready(agentId, runId);
    signal?.throwIfAborted();
    if (
      ![
        "apps",
        "windows",
        "observe",
        "click",
        "type",
        "key",
        "scroll",
        "menu",
      ].includes(method)
    )
      throw new Error("Unknown desktop operation.");
    if (method === "menu") throw new Error(UNSUPPORTED);
    if (method === "scroll" && !this.capabilities.scroll)
      throw new Error("Selected host has no scoped scroll capability.");
    if (this.busy)
      throw new Error(
        "Desktop busy: an accepted call must settle before another tool turn.",
      );
    this.busy = true;
    try {
      if (!this.lease) {
        const lease = new DesktopLease(
          this.options.leaseRoot ?? defaultDesktopLeaseRoot(),
          { agentId, runId },
        );
        await lease.acquire();
        try {
          this.ready(agentId, runId);
          signal?.throwIfAborted();
        } catch (error) {
          await lease.release();
          throw error;
        }
        this.lease = lease;
        this.owner = { agentId, runId };
        this.notify();
      }
      if (method === "apps") {
        exactArguments(input, []);
        this.invalidate();
        const apps = await this.call(
          agentId,
          runId,
          (signal) => this.provider!.apps(signal),
          (rows) => {
            if (!Array.isArray(rows) || rows.length > 100)
              throw new Error("Unbounded app inventory.");
            return rows.map(processTarget);
          },
          signal,
        );
        return {
          data: {
            apps: apps
              .filter((app) => this.config.allowedApps.includes(app.bundleId))
              .map((app) => ({
                appRef: this.add({
                  kind: "app",
                  target: app,
                  epoch: this.epoch,
                }),
                bundleId: app.bundleId,
                ...(this.nativeSnapshots ? { discoveryOnly: true } : {}),
              })),
          },
        };
      }
      if (method === "windows") {
        const args = exactArguments(input, ["appRef"], ["appRef"]),
          app = this.lookup(args.appRef, "app") as Extract<
            Reference,
            { kind: "app" }
          >;
        this.allowed(app.target);
        const windows = await this.call(
          agentId,
          runId,
          (signal) => this.provider!.windows(app.target, signal),
          (rows) => {
            if (!Array.isArray(rows) || rows.length > 50)
              throw new Error("Unbounded window inventory.");
            return rows.map((row) => {
              const window = windowTarget(row);
              if (!sameProcess(window, app.target))
                throw new Error("Window process generation changed.");
              return window;
            });
          },
          signal,
        );
        return {
          data: {
            windows: windows.map((window) => ({
              windowRef: this.add({
                kind: "window",
                target: window,
                epoch: this.epoch,
              }),
              bundleId: window.bundleId,
              ...(this.nativeSnapshots ? { discoveryOnly: true } : {}),
            })),
          },
        };
      }
      if (method === "observe") {
        const args = exactArguments(
            input,
            ["windowRef", "screenshot"],
            ["windowRef"],
          ),
          window = this.lookup(args.windowRef, "window") as Extract<
            Reference,
            { kind: "window" }
          >;
        if (
          args.screenshot !== undefined &&
          typeof args.screenshot !== "boolean"
        )
          throw new Error("Screenshot must be an explicit boolean.");
        const screenshot = args.screenshot === true;
        if (
          !this.capabilities.observe ||
          (screenshot &&
            (!this.config.captureConsent || !this.capabilities.images))
        )
          throw new Error(
            "Observation/screenshots are not qualified or lack explicit durable-chat capture consent.",
          );
        this.allowed(window.target);
        const validateObservation = (
          value: ProviderObservation,
          imageRequested: boolean,
        ): ProviderObservation => {
          const native = value.nativeSnapshot === true;
          if (native && !this.nativeSnapshots)
            throw new Error("Unexpected native snapshot contract.");
          const target: SnapshotTarget = native
            ? {
                ...processTarget(value.target),
                windowId: value.target.windowId,
              }
            : windowTarget(value.target);
          if (
            !(native
              ? sameProcess(target, window.target) &&
                target.windowId === window.target.windowId
              : sameWindow(target as WindowTarget, window.target)) ||
            typeof value.fresh !== "boolean" ||
            (!native && value.fresh !== true) ||
            typeof value.snapshotId !== "string" ||
            !value.snapshotId ||
            value.snapshotId.length > 200 ||
            (native && !/^ps1_[a-f0-9]{32}$/.test(value.snapshotId)) ||
            (!native &&
              (value.privacy !== "non-sensitive" ||
                value.surface !== "standard")) ||
            !["non-sensitive", "secure", "unknown"].includes(value.privacy) ||
            (imageRequested && value.privacy === "secure") ||
            !Array.isArray(value.elements) ||
            !value.elements.length ||
            value.elements.length > 200
          )
            throw new Error(
              "Observation is not exact or contains a known secure screenshot surface.",
            );
          const ids = new Set<string>();
          const elements = value.elements.map((row) => {
            if (
              typeof row.id !== "string" ||
              !row.id ||
              row.id.length > 200 ||
              ids.has(row.id) ||
              !(
                roles.has(row.role) ||
                (native &&
                  ["AXUnknown", "AXSecureTextField"].includes(row.role))
              ) ||
              (!native && row.secure !== false) ||
              typeof row.enabled !== "boolean" ||
              typeof row.actionable !== "boolean" ||
              (row.valueSettable !== undefined &&
                typeof row.valueSettable !== "boolean")
            )
              throw new Error(
                "Unknown or secure AX surface; refuse capture and input.",
              );
            ids.add(row.id);
            // Drop every provider content/value field, including title/label, before retaining references.
            return {
              id: row.id,
              role: row.role,
              ...(native
                ? row.secure === true
                  ? { secure: true }
                  : {}
                : { secure: false }),
              enabled: row.enabled,
              actionable:
                row.actionable &&
                row.secure !== true &&
                row.role !== "AXUnknown",
              valueSettable: row.valueSettable,
            };
          });
          if (value.image && !imageRequested)
            throw new Error("Unrequested screenshot.");
          if (imageRequested && !value.image)
            throw new Error("Requested exact-window image missing.");
          return {
            target,
            snapshotId: value.snapshotId,
            fresh: value.fresh,
            ...(native
              ? { nativeSnapshot: true as const, complete: null }
              : {}),
            privacy: value.privacy,
            surface: value.surface,
            elements,
            ...(value.image
              ? {
                  image: validateDesktopImage(value.image),
                  imageSize: {
                    width: Buffer.from(value.image.data, "base64").readUInt32BE(
                      16,
                    ),
                    height: Buffer.from(
                      value.image.data,
                      "base64",
                    ).readUInt32BE(20),
                  },
                  ...(native && value.coordinateReference === value.snapshotId
                    ? { coordinateReference: value.snapshotId }
                    : {}),
                }
              : {}),
          };
        };
        // Inspect AX/privacy before requesting pixels. The image-producing response must independently
        // re-prove the same exact target and non-sensitive standard surface; a prior read is not consent.
        let observed = await this.call(
          agentId,
          runId,
          (signal) => this.provider!.observe(window.target, false, signal),
          (value) => validateObservation(value, false),
          signal,
        );
        if (screenshot && observed.privacy === "secure")
          throw new Error("Known secure fields cannot be captured.");
        if (screenshot)
          observed = await this.call(
            agentId,
            runId,
            (signal) => this.provider!.observe(window.target, true, signal),
            (value) => validateObservation(value, true),
            signal,
          );
        // A new observation revokes prior element/snapshot references, not retained inventory references.
        for (const [id, value] of this.refs)
          if (value.kind === "observation" || value.kind === "element")
            this.refs.delete(id);
        const observationRef = this.add({
          kind: "observation",
          observation: { ...observed, image: undefined },
          created: Date.now(),
          epoch: this.epoch,
        });
        this.target = {
          app: observed.target.bundleId,
          window: String(args.windowRef),
        };
        this.notify();
        return {
          data: {
            observationRef,
            windowRef: args.windowRef,
            elements: observed.elements.map((element) => ({
              elementRef: this.add({
                kind: "element",
                observationRef,
                element,
                epoch: this.epoch,
              }),
              role: element.role,
              enabled: element.enabled,
              actionable: element.actionable,
              valueSettable: element.valueSettable === true,
            })),
            valuesRedacted: true,
            ...(observed.nativeSnapshot
              ? {
                  fresh: observed.fresh,
                  completeness: "unknown",
                  privacy: observed.privacy,
                  surface: "unknown",
                  coordinateInput: !!observed.coordinateReference,
                  warning:
                    "AX coverage and privacy are not exhaustive; images may contain sensitive content.",
                }
              : {}),
          },
          ...(observed.image ? { image: observed.image } : {}),
        };
      }
      const args = exactArguments(
        input,
        method === "key"
          ? ["observationRef", "key", "count"]
          : method === "scroll"
            ? ["elementRef", "direction", "amount"]
            : method === "type"
              ? ["elementRef", "text"]
              : ["elementRef", "observationRef", "x", "y"],
        method === "key"
          ? ["observationRef", "key"]
          : method === "scroll"
            ? ["elementRef", "direction"]
            : method === "type"
              ? ["elementRef", "text"]
              : [],
      );
      let element: ProviderElement | undefined;
      let observation: Extract<Reference, { kind: "observation" }>;
      const coordinateClick =
        method === "click" && args.observationRef !== undefined;
      if (coordinateClick) {
        if (
          args.elementRef !== undefined ||
          typeof args.x !== "number" ||
          typeof args.y !== "number"
        )
          throw new Error(
            "Choose an element or bounded image-pixel coordinates, not both.",
          );
        observation = this.lookup(
          args.observationRef,
          "observation",
        ) as typeof observation;
        const image = observation.observation.imageSize;
        if (
          !this.nativeSnapshots ||
          !observation.observation.coordinateReference ||
          !image ||
          !Number.isFinite(args.x) ||
          !Number.isFinite(args.y) ||
          args.x < 0 ||
          args.y < 0 ||
          args.x >= image.width ||
          args.y >= image.height
        )
          throw new Error(
            "Coordinates require the current exact-window screenshot and in-image pixels.",
          );
      } else if (method === "key") {
        observation = this.lookup(
          args.observationRef,
          "observation",
        ) as typeof observation;
        if (
          typeof args.key !== "string" ||
          !keys.has(args.key) ||
          (args.count !== undefined &&
            (!Number.isInteger(args.count) ||
              Number(args.count) < 1 ||
              Number(args.count) > 10))
        )
          throw new Error(
            "Key/chord is not allowlisted; clipboard, command/control/option and unbounded keys are refused.",
          );
      } else {
        const reference = this.lookup(args.elementRef, "element") as Extract<
          Reference,
          { kind: "element" }
        >;
        if (
          method === "click" &&
          (args.x !== undefined || args.y !== undefined)
        )
          throw new Error(
            "Coordinates require an observation reference, not an element reference.",
          );
        element = reference.element;
        observation = this.lookup(
          reference.observationRef,
          "observation",
        ) as typeof observation;
        if (
          !element.enabled ||
          element.secure === true ||
          (method === "click" && !element.actionable) ||
          (method === "type" &&
            (!["AXTextField", "AXTextArea"].includes(element.role) ||
              element.valueSettable !== true))
        )
          throw new Error("Element is not a qualified enabled action/field.");
        if (
          method === "type" &&
          (typeof args.text !== "string" ||
            !args.text ||
            args.text.length > 1000 ||
            /[\x00-\x1f\x7f]/.test(args.text))
        )
          throw new Error(
            "Use bounded non-secret literal text only; control characters are refused.",
          );
      }
      if (
        !observation.observation.fresh ||
        observation.observation.privacy === "secure"
      )
        throw new Error("Fresh non-secure observation required before input.");
      if (
        method === "scroll" &&
        (!["up", "down", "left", "right"].includes(String(args.direction)) ||
          (args.amount !== undefined &&
            (!Number.isInteger(args.amount) ||
              Number(args.amount) < 1 ||
              Number(args.amount) > 50)))
      )
        throw new Error("Use a supported scroll direction and 1–50 ticks.");
      if (!this.capabilities[method])
        throw new Error("Desktop action capability is not qualified.");
      if (Date.now() - observation.created > REF_LIFETIME)
        throw new Error(
          "Desktop observation expired; observe the exact target again.",
        );
      this.allowed(observation.observation.target);
      const mutation = {
        kind: method,
        target: structuredClone(observation.observation.target),
        snapshotId: observation.observation.snapshotId,
        ...(element ? { elementId: element.id } : {}),
        ...(method === "type" ? { text: args.text as string } : {}),
        ...(method === "scroll"
          ? {
              direction: args.direction as string,
              amount: (args.amount ?? 3) as number,
            }
          : {}),
        ...(coordinateClick
          ? { coordinates: { x: args.x as number, y: args.y as number } }
          : {}),
        ...(method === "key"
          ? { key: args.key as string, count: (args.count ?? 1) as number }
          : {}),
      };
      const outcome = (await this.call(
        agentId,
        runId,
        (signal) => {
          if (Date.now() - observation.created > REF_LIFETIME)
            throw new Error("Desktop observation expired before dispatch.");
          return this.provider!.mutate(mutation, signal);
        },
        (value) =>
          desktopMutationOutcome(value, mutation.target, this.nativeSnapshots),
        signal,
      )) as ReturnType<typeof desktopMutationOutcome>;
      this.invalidate();
      if (outcome.unsafe) {
        this.unsafe();
        await this.unsafePersistence;
      }
      this.notify();
      return {
        data: {
          ...outcome,
          guidance: outcome.unsafe
            ? UNSAFE
            : "Do not replay; get a fresh exact-window observation to verify before any further action.",
        },
      };
    } finally {
      this.busy = false;
    }
  }
}
