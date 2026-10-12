import { readFile, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Inspect every cgroup descendant, not just MainPID or a formerly reserved port. */
export async function cgroupSocketInventory(
  group: string,
  paths = { cgroup: "/sys/fs/cgroup", proc: "/proc" },
) {
  if (
    !group.startsWith("/") ||
    group.includes("..") ||
    resolve(paths.cgroup, "." + group) === resolve(paths.cgroup)
  )
    throw new Error("Invalid app cgroup.");
  const pids = new Set<string>();
  const visit = async (directory: string) => {
    for (const pid of (await readFile(join(directory, "cgroup.procs"), "utf8"))
      .trim()
      .split(/\s+/))
      if (/^[1-9][0-9]*$/.test(pid)) pids.add(pid);
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await visit(join(directory, entry.name));
  };
  await visit(join(paths.cgroup, group));
  const sockets = new Set<string>();
  const exiting = async (pid: string) => {
    try {
      const stat = await readFile(join(paths.proc, pid, "stat"), "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      // PF_EXITING is set before proc/fd becomes inaccessible during do_exit.
      return (
        ["Z", "X", "x"].includes(fields[0]!) || (Number(fields[6]) & 4) !== 0
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  };
  const gone = async (pid: string, error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    return (
      code === "ENOENT" ||
      (["EACCES", "EPERM"].includes(code ?? "") && (await exiting(pid)))
    );
  };
  for (const pid of pids) {
    const fdPath = join(paths.proc, pid, "fd");
    try {
      for (const fd of await readdir(fdPath)) {
        try {
          const inode = (await readlink(join(fdPath, fd))).match(
            /^socket:\[([0-9]+)\]$/,
          )?.[1];
          if (inode) sockets.add(inode);
        } catch (error) {
          if (!(await gone(pid, error))) throw error;
        }
      }
    } catch (error) {
      if (!(await gone(pid, error))) throw error;
    }
  }
  const tcpListeners: string[] = [];
  for (const table of ["tcp", "tcp6"])
    for (const line of (await readFile(join(paths.proc, "net", table), "utf8"))
      .trim()
      .split("\n")
      .slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A" && sockets.has(fields[9]!))
        tcpListeners.push(fields[1]!);
    }
  const unixListeners: string[] = [];
  for (const line of (await readFile(join(paths.proc, "net", "unix"), "utf8"))
    .trim()
    .split("\n")
    .slice(1)) {
    const fields = line
      .trim()
      .match(/^\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+(\d+)(?:\s+(.*))?$/);
    if (fields?.[1] === "00010000" && sockets.has(fields[2]!))
      unixListeners.push(fields[3] ?? "");
  }
  return { tcpListeners, unixListeners };
}
