import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "development";
// macOS's long /var/folders root exceeds Unix socket limits in nested fixtures.
// Use its short system temp root, canonicalized so path/symlink safety tests keep
// their production semantics. Every fixture still allocates a unique directory.
process.env.TMPDIR = realpathSync(
  process.platform === "darwin" ? "/tmp" : tmpdir(),
);
// A test Harness is a new root, not the Pi worker that launched `bun run check`.
// Inheriting PI_SUBAGENT_CHILD disables its extension; inherited session/config
// paths can also reach the operator's real runner. Fixtures set their own data.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_")) delete process.env[key];
}
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "jelly-test-pi-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));
