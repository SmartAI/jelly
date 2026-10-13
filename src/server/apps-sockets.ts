import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  realpath,
  unlink,
  rmdir,
} from "node:fs/promises";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";

export interface SocketOwner {
  instanceId: string;
  appId: string;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
export function runtimeSocketPath(
  owner: SocketOwner,
  base = `/tmp/jelly-as-${process.getuid?.()}`,
) {
  const path = join(
    resolve(base),
    `i${hash(owner.instanceId)}`,
    `a${hash(owner.appId)}`,
    "http.sock",
  );
  validateSocketPath(path, owner);
  return path;
}
export function validateSocketPath(path: string, owner: SocketOwner) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(owner.instanceId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(owner.appId) ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    Buffer.byteLength(path) > 103 ||
    /[\x00-\x1f\x7f]/.test(path) ||
    basename(path) !== "http.sock" ||
    basename(dirname(path)) !== `a${hash(owner.appId)}` ||
    basename(dirname(dirname(path))) !== `i${hash(owner.instanceId)}`
  )
    throw new Error(
      "Invalid instance/app Unix socket path (maximum 103 bytes).",
    );
}
async function directory(path: string, create: boolean) {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    (await realpath(path)) !== path
  )
    throw new Error(
      "App socket directories must be canonical, owner-only and owned by this user.",
    );
}
export async function verifySocketParent(
  path: string,
  owner: SocketOwner,
  create = false,
) {
  validateSocketPath(path, owner);
  const appDirectory = dirname(path),
    instanceDirectory = dirname(appDirectory),
    base = dirname(instanceDirectory);
  if ((await realpath(dirname(base))) !== dirname(base))
    throw new Error("App socket base has a symlinked ancestor.");
  await directory(base, create);
  await directory(instanceDirectory, create);
  await directory(appDirectory, create);
  const marker = join(appDirectory, "owner.json");
  if (create)
    await writeFile(
      marker,
      JSON.stringify({ instanceId: owner.instanceId, appId: owner.appId }),
      {
        mode: 0o600,
        flag: "wx",
      },
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const info = await lstat(marker);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error("Invalid app socket owner marker.");
  const saved = JSON.parse(await readFile(marker, "utf8"));
  if (saved.instanceId !== owner.instanceId || saved.appId !== owner.appId)
    throw new Error("App socket ownership conflict.");
}
export async function validateRuntimeSocket(
  path: string,
  owner: SocketOwner,
): Promise<boolean> {
  await verifySocketParent(path, owner);
  try {
    const info = await lstat(path);
    // The parent was verified canonical above; lstat rejects a symlink leaf.
    // realpath(socket) is not portable (Bun/macOS can return EOPNOTSUPP).
    if (!info.isSocket() || info.uid !== process.getuid?.())
      throw new Error("App runtime socket is not an owned socket.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function prepareRuntimeSocket(path: string, owner: SocketOwner) {
  await verifySocketParent(path, owner, true);
  // Only after the owned unit has stopped: never unlink a symlink/regular file.
  if (await validateRuntimeSocket(path, owner)) await unlink(path);
}
export async function removeRuntimeSocket(path: string, owner: SocketOwner) {
  try {
    await prepareRuntimeSocket(path, owner);
    await unlink(join(dirname(path), "owner.json"));
    await rmdir(dirname(path));
    // Other apps/instances may still use these directories.
    await rmdir(dirname(dirname(path))).catch((error) => {
      if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
