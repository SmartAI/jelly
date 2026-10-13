import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopOwner } from "../shared/desktop";

export const defaultDesktopLeaseRoot = () =>
  join(homedir(), "Library/Application Support/Jelly/desktop-leases");
/** Cooperative, user-wide exclusion, not an OS sandbox. Never reclaim on PID/time evidence.
 * A crash between mkdir and the owner record intentionally leaves a blocking unknown lease. */
export class DesktopLease {
  readonly token = randomUUID();
  private owned = false;
  private quarantined = false;
  private path: string;
  constructor(
    private root: string,
    private owner: DesktopOwner,
  ) {
    this.path = join(root, "desktop.lock");
  }
  async acquire() {
    const root = await mkdir(this.root, { recursive: true, mode: 0o700 })
      .then(() => lstat(this.root))
      .catch(() => {
        throw new Error(
          "Cannot inspect desktop lease storage; retain exclusion and repair operator setup.",
        );
      });
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      root.mode & 0o077
    )
      throw new Error(
        "Desktop lease root must be an owner-only directory; repair its ownership/permissions.",
      );
    try {
      await mkdir(this.path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "Desktop busy or quarantined in another instance. Unknown leases are never reclaimed by PID or age; obtain qualified host drain/recovery before operator removal.",
        );
      throw new Error(
        "Cannot acquire desktop lease; verify owner-only storage.",
      );
    }
    this.owned = true;
    try {
      await this.write("owned");
    } catch {
      this.quarantined = true;
      throw new Error(
        "Desktop lease persistence failed; ownership is quarantined, not safely released.",
      );
    }
  }
  private async write(state: "owned" | "quarantined") {
    const temporary = join(this.path, `${this.token}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ token: this.token, owner: this.owner, state }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(this.path, "owner.json"));
  }
  private async ownerRecord() {
    const path = join(this.path, "owner.json"),
      info = await lstat(path).catch(() => {
        throw new Error(
          "Desktop owner record cannot be verified; retain exclusion.",
        );
      });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > 4096
    )
      throw new Error("Desktop owner record is unproved; retain exclusion.");
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error(
        "Desktop owner record cannot be decoded; retain exclusion.",
      );
    }
  }
  async assertOwned() {
    const info = await lstat(this.path).catch(() => {
      throw new Error(
        "Desktop lease is missing or unverifiable; no input authority is permitted.",
      );
    });
    if (
      !this.owned ||
      this.quarantined ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error(
        "Desktop lease lost/unsafe; no new authority is permitted.",
      );
    const owner = await this.ownerRecord();
    if (owner.token !== this.token || owner.state !== "owned")
      throw new Error(
        "Desktop lease generation changed; do not dispatch input.",
      );
  }
  async quarantine() {
    this.quarantined = true;
    if (!this.owned) return;
    // Failure still leaves the durable directory, which no instance may reclaim automatically.
    try {
      const owner = await this.ownerRecord();
      if (owner.token === this.token) await this.write("quarantined");
    } catch {
      /* The blocking directory itself is the fail-closed marker. */
    }
  }
  async release() {
    if (!this.owned) return;
    if (this.quarantined)
      throw new Error(
        "Desktop ownership is quarantined; host completion has not been proved.",
      );
    await this.assertOwned();
    await rm(this.path, { recursive: true }).catch(() => {
      throw new Error(
        "Desktop lease release could not be confirmed; retain exclusion.",
      );
    });
    this.owned = false;
  }
}
