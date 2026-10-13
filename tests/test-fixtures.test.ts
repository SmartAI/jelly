import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureBrowserPath } from "./fixtures/browser";

test("browser fixtures discover executable candidates and never fall back from explicit configuration", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jelly-fixture-path-")));
  try {
    const executable = join(dir, "Chromium with spaces");
    const notExecutable = join(dir, "not-executable");
    const missing = join(dir, "missing");
    writeFileSync(executable, "fixture", { mode: 0o700 });
    writeFileSync(notExecutable, "fixture", { mode: 0o600 });
    expect(fixtureBrowserPath("", [missing, notExecutable, executable])).toBe(
      executable,
    );
    expect(fixtureBrowserPath(executable, [missing])).toBe(executable);
    expect(() => fixtureBrowserPath(dir, [executable])).toThrow(
      "never falls back",
    );
    expect(() => fixtureBrowserPath(missing, [executable])).toThrow(
      "never falls back",
    );
    expect(() => fixtureBrowserPath("relative/chrome", [executable])).toThrow(
      "absolute executable",
    );
    expect(() => fixtureBrowserPath("", [])).toThrow("install chromium");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test preload canonicalizes the platform temporary root without weakening path checks", () => {
  expect(tmpdir()).toBe(realpathSync(tmpdir()));
});

test("test preload isolates inherited Pi child authority and operator configuration", () => {
  expect(process.env.PI_SUBAGENT_CHILD).toBeUndefined();
  expect(process.env.PI_SUBAGENT_PARENT_SESSION).toBeUndefined();
  expect(process.env.PI_SESSION_FILE).toBeUndefined();
  expect(process.env.PI_CODING_AGENT_DIR).toContain("jelly-test-pi-");
});

test("test preload selects React development build even in a production shell", async () => {
  expect(process.env.NODE_ENV).toBe("development");
  const { act } = await import("react");
  expect(typeof act).toBe("function");
});
