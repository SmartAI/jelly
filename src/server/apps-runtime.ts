import { createServer, isIP } from "node:net";
import { request } from "node:http";
import { cgroupSocketInventory } from "./apps-isolation";
import { validateRuntimeSocket, type SocketOwner } from "./apps-sockets";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type {
  AppsCapabilities,
  AppObservation,
  AppGatewayIdentity,
} from "../shared/apps";
import { tailnetAddress } from "./apps-validation";

export interface AppsCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface AppsAdapter {
  capabilities(): Promise<AppsCapabilities>;
  gatewayExecutable(): Promise<string>;
  portAvailable(port: number, addresses: string[]): Promise<boolean>;
  command(
    executable: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): Promise<AppsCommandResult>;
  installUnit(name: string, content: string): Promise<void>;
  readUnit(name: string): Promise<string | null>;
  removeUnit(name: string): Promise<void>;
  systemctl(
    action:
      "daemon-reload" | "enable" | "disable" | "start" | "stop" | "restart",
    units?: string[],
  ): Promise<void>;
  state(name: string): Promise<AppObservation["serviceState"]>;
  health(
    origin: string,
    path: string,
    identity?: AppGatewayIdentity,
  ): Promise<boolean>;
  socketHealth(socket: string, path: string): Promise<boolean>;
  runtimeIsolation(
    unit: string,
    socket: string,
    owner: SocketOwner,
  ): Promise<{ safe: boolean; ready: boolean; reason?: string }>;
  logs(units: string[], limit: number): Promise<string>;
}
export function defaultAppsCapabilities(
  platform = process.platform,
): AppsCapabilities {
  return {
    supported: platform === "linux",
    platform,
    systemd: false,
    lingering: false,
    tailscale: false,
    tailnetAddresses: [],
    tailnetHostname: null,
    managedDeployment: false,
    embedding: platform === "linux",
    gatewayNode: false,
    gatewayNodeVersion: null,
    privateHttps: false,
    cookieIsolation: "http-only-prefixed",
    warnings: [
      "Inspect Apps capabilities before deploying.",
      "Gateway cookies are authenticated, app-prefixed and HttpOnly; JavaScript session cookies and duplicate/path-shadow cookie names are unsupported.",
      "Shared-host cookie-jar exhaustion and injected path/Domain shadows can deny availability; use independent hosts for JavaScript-cookie compatibility or stronger availability isolation. Direct mode is not a cookie isolation waiver.",
      "Private HTTP is not a secure context; HTTPS Jelly requires direct launch.",
    ],
  };
}
export function unitName(
  instanceId: string,
  id: string,
  gateway = false,
): string {
  return `jelly-app-${createHash("sha256")
    .update(instanceId + "\0" + id)
    .digest("hex")
    .slice(0, 32)}${gateway ? "-gateway" : ""}.service`;
}
export function unitOwner(instanceId: string, id: string): string {
  if (
    ![instanceId, id].every((value) =>
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value),
    )
  )
    throw new Error("Invalid app unit owner.");
  return `# Jelly-owned instance: ${instanceId} app: ${id}\n`;
}
function validUnit(name: string) {
  if (!/^jelly-app-[a-zA-Z0-9][a-zA-Z0-9_-]*\.service$/.test(name))
    throw new Error("Only Jelly-owned app units may be managed.");
}
export function unitQuote(value: string, expandEnvironment = true): string {
  if (/[\x00\r\n]/.test(value)) throw new Error("Invalid systemd field.");
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%");
  return (
    '"' + (expandEnvironment ? escaped.replace(/\$/g, "$$$$") : escaped) + '"'
  );
}
function unitPath(value: string): string {
  if (!isAbsolute(value) || /[\x00\r\n]/.test(value) || value !== value.trim())
    throw new Error("Invalid absolute systemd path.");
  // WorkingDirectory is one raw path, not an ExecStart word list: quotes become
  // literal filename characters. Only systemd specifiers need escaping here.
  return value.replace(/%/g, "%%");
}
export function appUnit(
  instanceId: string,
  id: string,
  command: string[],
  cwd: string,
  environmentFiles: string[] = [],
  gateway = false,
): string {
  if (!command.length || !isAbsolute(command[0]!) || !isAbsolute(cwd))
    throw new Error("App services require absolute paths.");
  return `${unitOwner(instanceId, id)}[Unit]\nDescription=Jelly app ${id}\n${gateway ? `After=${unitName(instanceId, id)}\n` : ""}StartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${unitPath(cwd)}\nExecStart=${command.map((value) => unitQuote(value)).join(" ")}\n${environmentFiles.map((path) => `EnvironmentFile=${unitQuote(path, false)}\n`).join("")}Restart=on-failure\nRestartSec=2\nTimeoutStopSec=20\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=yes\n${gateway ? "" : "SocketBindDeny=ipv4:tcp ipv6:tcp\n"}\n[Install]\nWantedBy=default.target\n`;
}
export class SystemAppsAdapter implements AppsAdapter {
  private directory = join(homedir(), ".config/systemd/user");
  private nodeExecutable: string | null = null;
  async gatewayExecutable() {
    if (!this.nodeExecutable) await this.capabilities();
    if (!this.nodeExecutable)
      throw new Error(
        "Install Node.js >=20 at a persistent absolute path for the isolated Apps gateway.",
      );
    return this.nodeExecutable;
  }
  async command(
    executable: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): Promise<AppsCommandResult> {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform === "linux",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "linux" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    }, options.timeoutMs);
    // Drain and bound output; timeouts kill the whole build/test process group.
    const drain = async (stream: NodeJS.ReadableStream) => {
      let output = Buffer.alloc(0);
      for await (const chunk of stream)
        output = Buffer.concat([output, Buffer.from(chunk)]).subarray(-32000);
      return output.toString("utf8");
    };
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        drain(child.stdout),
        drain(child.stderr),
        exited,
      ]);
      return { code: timedOut ? 124 : code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }
  private async run(executable: string, args: string[]) {
    try {
      return await this.command(executable, args, {
        cwd: homedir(),
        env: {},
        timeoutMs: 10000,
      });
    } catch {
      return { code: 1, stdout: "", stderr: "Command unavailable." };
    }
  }
  async capabilities(): Promise<AppsCapabilities> {
    const cap = defaultAppsCapabilities();
    if (!cap.supported) {
      cap.warnings.unshift(
        "Managed Apps require Linux with systemd user services. Linked private apps remain supported.",
      );
      return cap;
    }
    const [systemd, linger, tailscale, node] = await Promise.all([
      this.run("systemctl", ["--user", "show-environment"]),
      this.run("loginctl", [
        "show-user",
        String(process.getuid?.() ?? ""),
        "-p",
        "Linger",
        "--value",
      ]),
      this.run("tailscale", ["status", "--json"]),
      this.run("node", [
        "--input-type=module",
        "-e",
        "import 'node:http'; if(process.release.name!=='node'||Number(process.versions.node.split('.')[0])<20)process.exit(1);console.log(JSON.stringify({executable:process.execPath,version:process.versions.node}));",
      ]),
    ]);
    cap.systemd = systemd.code === 0;
    cap.lingering = linger.code === 0 && linger.stdout.trim() === "yes";
    try {
      const status = JSON.parse(tailscale.stdout);
      cap.tailnetAddresses =
        status.BackendState === "Running" && Array.isArray(status.TailscaleIPs)
          ? status.TailscaleIPs.filter(
              (ip: unknown) => typeof ip === "string" && tailnetAddress(ip),
            )
          : [];
      const dns = status.Self?.DNSName?.replace(/\.$/, "");
      cap.tailnetHostname =
        typeof dns === "string" &&
        /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(dns)
          ? dns.toLowerCase()
          : null;
      cap.tailscale = cap.tailnetAddresses.length > 0;
    } catch {
      /* Disconnected tailnet must not disable local apps. */
    }
    try {
      const discovered = JSON.parse(node.stdout);
      if (
        node.code === 0 &&
        typeof discovered.executable === "string" &&
        isAbsolute(discovered.executable) &&
        !discovered.executable.includes("/worktrees/") &&
        !discovered.executable.includes("/pi-worktree-")
      ) {
        this.nodeExecutable = discovered.executable;
        cap.gatewayNode = true;
        cap.gatewayNodeVersion = discovered.version;
      } else this.nodeExecutable = null;
    } catch {
      this.nodeExecutable = null;
    }
    const isolationAvailable = await Promise.all(
      [
        "/sys/fs/cgroup/cgroup.controllers",
        "/proc/net/tcp",
        "/proc/net/tcp6",
        "/proc/net/unix",
      ].map((path) => readFile(path)),
    ).then(
      () => true,
      () => false,
    );
    cap.managedDeployment =
      cap.systemd && cap.lingering && isolationAvailable && cap.gatewayNode;
    if (!cap.gatewayNode)
      cap.warnings.unshift(
        "Install Node.js >=20 at a persistent absolute path; it is required for standards-compliant streaming/WebSocket Apps gateways.",
      );
    if (!cap.systemd)
      cap.warnings.unshift(
        "Start a systemd user session; systemctl --user is unavailable.",
      );
    if (!cap.lingering)
      cap.warnings.unshift(
        "Enable user lingering (loginctl enable-linger for this user) to persist apps across logout/reboot, then retry.",
      );
    if (!isolationAvailable)
      cap.warnings.unshift(
        "Managed Apps require readable Linux cgroup-v2 and /proc socket inventories.",
      );
    cap.warnings.push(
      "Managed runtimes require APP_SOCKET and cannot expose TCP listeners. SocketBindDeny is defense-in-depth where user-manager BPF privileges permit; cgroup-wide checks quarantine unsafe bindings. Ordinary outbound connections remain supported; explicit TCP source binding is unsupported when bind restrictions are enforced.",
    );
    if (!cap.tailscale)
      cap.warnings.push(
        "Connect Tailscale for private remote access; local app access remains available.",
      );
    return cap;
  }
  async portAvailable(port: number, addresses: string[]) {
    const servers: ReturnType<typeof createServer>[] = [];
    try {
      for (const host of new Set(addresses)) {
        const server = createServer();
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host, port, ipv6Only: isIP(host) === 6 }, resolve);
        });
      }
      return true;
    } catch {
      return false;
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    }
  }
  async readUnit(name: string) {
    validUnit(name);
    try {
      return await readFile(join(this.directory, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async installUnit(name: string, content: string) {
    validUnit(name);
    const owner = content.match(
      /^# Jelly-owned instance: ([a-zA-Z0-9_-]+) app: ([a-zA-Z0-9_-]+)\n/,
    );
    if (
      !owner ||
      ![
        unitName(owner[1]!, owner[2]!),
        unitName(owner[1]!, owner[2]!, true),
      ].includes(name)
    )
      throw new Error(
        "App unit name and instance/app ownership marker must match.",
      );
    const old = await this.readUnit(name);
    if (old && !old.startsWith(content.split("\n")[0]! + "\n"))
      throw new Error("Refusing to overwrite a unit not owned by this app.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = join(this.directory, `.${name}.${crypto.randomUUID()}`);
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, join(this.directory, name));
  }
  async removeUnit(name: string) {
    validUnit(name);
    const content = await this.readUnit(name);
    const owner = content?.match(
      /^# Jelly-owned instance: ([a-zA-Z0-9_-]+) app: ([a-zA-Z0-9_-]+)\n/,
    );
    if (
      content &&
      (!owner ||
        ![
          unitName(owner[1]!, owner[2]!),
          unitName(owner[1]!, owner[2]!, true),
        ].includes(name))
    )
      throw new Error("Refusing to remove a foreign unit.");
    await unlink(join(this.directory, name)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  async systemctl(
    action: Parameters<AppsAdapter["systemctl"]>[0],
    units: string[] = [],
  ) {
    units.forEach(validUnit);
    if (action !== "daemon-reload" && !units.length)
      throw new Error("App unit required.");
    const result = await this.run("systemctl", ["--user", action, ...units]);
    if (result.code)
      throw new Error(
        `App service operation ${action} failed. Check user systemd availability and app logs.`,
      );
  }
  async state(name: string): Promise<AppObservation["serviceState"]> {
    validUnit(name);
    const result = await this.run("systemctl", [
      "--user",
      "show",
      name,
      "-p",
      "ActiveState",
      "--value",
    ]);
    if (result.code) return "unknown";
    return (
      (
        {
          active: "running",
          activating: "starting",
          inactive: "stopped",
          deactivating: "stopped",
          failed: "failed",
        } as const
      )[result.stdout.trim() as "active"] ?? "unknown"
    );
  }
  async health(origin: string, path: string, identity?: AppGatewayIdentity) {
    const url = new URL(origin);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      !path.startsWith("/") ||
      path.startsWith("//")
    )
      throw new Error("Only allocated loopback origins may be health checked.");
    try {
      const response = await fetch(origin + path, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
        headers: { Connection: "close" },
      });
      await response.body?.cancel();
      return (
        response.status >= 200 &&
        response.status < 300 &&
        (!identity ||
          (response.headers.get("x-jelly-instance-id") ===
            identity.instanceId &&
            response.headers.get("x-jelly-app-id") === identity.appId &&
            response.headers.get("x-jelly-deployment-revision") ===
              identity.deploymentRevision))
      );
    } catch {
      return false;
    }
  }
  async socketHealth(socket: string, path: string) {
    if (!isAbsolute(socket) || !path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid socket health target.");
    return new Promise<boolean>((resolve) => {
      const req = request(
        { socketPath: socket, path, headers: { Connection: "close" } },
        (response) => {
          response.resume();
          resolve(response.statusCode! >= 200 && response.statusCode! < 300);
        },
      );
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
  }
  async runtimeIsolation(unit: string, socket: string, owner: SocketOwner) {
    validUnit(unit);
    let stage = "Socket ownership verification";
    try {
      const ready = await validateRuntimeSocket(socket, owner);
      stage = "Owned cgroup discovery";
      const result = await this.run("systemctl", [
        "--user",
        "show",
        unit,
        "-p",
        "ControlGroup",
        "--value",
      ]);
      if (result.code)
        return {
          safe: false,
          ready: false,
          reason: "User systemd cgroup discovery failed",
        };
      const group = result.stdout.trim();
      if (!group) return { safe: true, ready: false };
      if (!group.endsWith("/" + unit))
        return {
          safe: false,
          ready: false,
          reason: "Owned cgroup identity does not match the unit",
        };
      stage = "Owned cgroup socket inventory";
      let inventory: Awaited<ReturnType<typeof cgroupSocketInventory>>;
      try {
        // proc/fd can briefly deny access during exec/exit even before PF_EXITING
        // becomes visible. Retry the entire inventory, never declare that PID safe.
        for (let attempt = 0; ; attempt++) {
          try {
            inventory = await cgroupSocketInventory(group);
            break;
          } catch (error) {
            if (
              attempt >= 2 ||
              !["EACCES", "EPERM"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              )
            )
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // An exited/restarting unit's cgroup can disappear between systemctl and
        // inventory. No remaining group means not-ready, not an unsafe binding.
        await readFile("/sys/fs/cgroup/cgroup.controllers");
        const exists = await readFile(
          join("/sys/fs/cgroup", group, "cgroup.procs"),
        ).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (!exists) return { safe: true, ready: false };
        throw error;
      }
      if (inventory.tcpListeners.length)
        return {
          safe: false,
          ready: false,
          reason:
            "TCP listeners found in the owned runtime cgroup or descendants",
        };
      return {
        safe: true,
        ready: ready && inventory.unixListeners.includes(socket),
      };
    } catch (error) {
      return {
        safe: false,
        ready: false,
        reason: `${stage} failed (${(error as NodeJS.ErrnoException).code ?? "invalid ownership"})`,
      };
    }
  }
  async logs(units: string[], limit: number) {
    units.forEach(validUnit);
    const result = await this.run("journalctl", [
      "--user",
      ...units.flatMap((unit) => ["-u", unit]),
      "-n",
      String(limit),
      "--no-pager",
      "-o",
      "cat",
    ]);
    if (result.code) throw new Error("App journal unavailable.");
    return result.stdout;
  }
}
