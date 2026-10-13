import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { chromium } from "playwright-core";

/** Test-only discovery; never installs a browser or opens a user's profile. */
export function fixtureBrowserPath(
  configured = process.env.JELLY_BROWSER_PATH,
  candidates = [
    chromium.executablePath(),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
): string {
  for (const path of configured ? [configured] : candidates) {
    if (!isAbsolute(path)) continue;
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  throw new Error(
    "Browser fixture requires an installed Chromium: run bunx playwright-core install chromium, or set JELLY_BROWSER_PATH to an absolute executable path. An invalid explicit path never falls back.",
  );
}
