// Read-only, opt-in Mac installation diagnostic. This is NOT live automation
// qualification: it never starts MCP, a daemon, or an app, and never captures/input.
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import {
  PEEKABOO_VERSION,
  QUALIFICATION_BLOCKER,
  restrictedPeekabooEnvironment,
} from "../src/server/peekaboo";

const args = process.argv.slice(2).filter((value) => value !== "--");
const known = new Set([
  "--inspect-installed",
  "--cli",
  "--host-app",
  "--socket",
]);
function selection(flag: string, fallback: string) {
  const index = args.indexOf(flag);
  const value = index < 0 ? fallback : args[index + 1];
  if (!value || !isAbsolute(value) || value.includes("\0"))
    throw new Error("Diagnostic paths must be absolute operator selections.");
  return value;
}
async function command(executable: string, argv: string[]) {
  return await new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(
      executable,
      argv,
      {
        env: restrictedPeekabooEnvironment(),
        timeout: 10000,
        maxBuffer: 65536,
        encoding: "utf8",
      },
      (error, stdout, stderr) =>
        resolve({ ok: !error, output: stdout + stderr }),
    );
  });
}
async function present(path: string, kind: "app" | "socket") {
  try {
    const info = await lstat(path);
    return kind === "app" ? info.isDirectory() : info.isSocket();
  } catch {
    return false;
  }
}
try {
  for (let index = 0; index < args.length; index++) {
    if (!known.has(args[index]!)) throw new Error("Unknown diagnostic option.");
    if (args[index] !== "--inspect-installed") index++;
  }
  if (!args.includes("--inspect-installed")) {
    console.log(
      "Opt-in read-only installation diagnostic: bun run test:peekaboo:mac -- --inspect-installed --cli /absolute/peekaboo [--host-app /absolute/Peekaboo.app] [--socket /absolute/bridge.sock]",
    );
    process.exitCode = 2;
  } else if (process.platform !== "darwin") {
    console.log(
      JSON.stringify({
        qualified: false,
        reason: "A Mac backend is required.",
      }),
    );
    process.exitCode = 1;
  } else {
    const cli = await realpath(
      selection("--cli", "/opt/homebrew/bin/peekaboo"),
    );
    if (cli.includes(".app/"))
      throw new Error(
        "Select the standalone CLI, not the app bundle executable.",
      );
    const host = selection("--host-app", "/Applications/Peekaboo.app");
    const socket = selection(
      "--socket",
      join(homedir(), "Library/Application Support/Peekaboo/bridge.sock"),
    );
    const signature = await command("/usr/bin/codesign", [
      "--verify",
      "--strict",
      cli,
    ]);
    const details = signature.ok
      ? await command("/usr/bin/codesign", ["-d", "--verbose=4", cli])
      : { ok: false, output: "" };
    const team =
      details.output.match(/^TeamIdentifier=(Y5PE65HELJ|FWJYW4S8P8)$/m)?.[1] ??
      null;
    const identityMatches = /^Identifier=boo\.peekaboo\.peekaboo$/m.test(
      details.output,
    );
    // Never run even --version unless the chosen binary has the expected signed identity.
    const version =
      signature.ok && team && identityMatches
        ? await command(cli, ["--version"])
        : { ok: false, output: "" };
    const installedVersion =
      version.output.match(/^Peekaboo ([A-Za-z0-9.-]{1,80})(?:\s|$)/)?.[1] ??
      null;
    console.log(
      JSON.stringify(
        {
          qualified: false,
          candidateVersion: PEEKABOO_VERSION,
          installedVersion,
          signatureValid: signature.ok && identityMatches,
          releaseSigning: /^Authority=Developer ID Application:/m.test(
            details.output,
          ),
          hostAppPresent: await present(host, "app"),
          selectedSocketPresent: await present(socket, "socket"),
          hostPermissions: "unknown",
          liveCaptures: 0,
          liveMutations: 0,
          reason:
            installedVersion !== PEEKABOO_VERSION
              ? "Installed CLI does not match the candidate; no Bridge connection or fallback was attempted."
              : QUALIFICATION_BLOCKER,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1; // No accepted real-Mac qualification, even with a matching version.
  }
} catch {
  console.log(
    JSON.stringify({
      qualified: false,
      reason:
        "Installation diagnostic failed. Verify absolute CLI/app/socket selections; no host connection or fallback was attempted.",
    }),
  );
  process.exitCode = 1;
}
