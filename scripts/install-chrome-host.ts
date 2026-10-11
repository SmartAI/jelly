import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
// Explicit paths support disposable test environments; no system-level install.
const args = process.argv.slice(2);
const option = (key: string) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
const data = option("--data-dir"),
  id = option("--extension-id") ?? "mikadpfmkipiafkemjplldmfckomphcf";
const root = resolve(
  option("--chrome-config") ?? join(homedir(), ".config/google-chrome"),
);
if (!data || (!args.includes("--uninstall") && !/^[a-p]{32}$/.test(id ?? "")))
  throw new Error(
    "Usage: bun scripts/install-chrome-host.ts --data-dir PATH [--extension-id ID] [--chrome-config PATH] [--uninstall]",
  );
const bridge = join(resolve(data), "chrome-bridge");
const manifest = join(root, "NativeMessagingHosts/org.jelly.browser.json");
const own = join(bridge, "native-host");
if (args.includes("--uninstall")) {
  if (existsSync(manifest)) {
    const old = JSON.parse(readFileSync(manifest, "utf8"));
    if (old.path !== join(own, "launch"))
      throw new Error(
        "Manifest belongs to another Jelly instance; not removed.",
      );
    unlinkSync(manifest);
  }
  rmSync(own, { recursive: true, force: true });
  if (existsSync(join(bridge, "extension-id")))
    unlinkSync(join(bridge, "extension-id"));
  console.log(
    "Jelly native host removed. Disconnect/remove the extension separately; restart Jelly to revoke existing connections.",
  );
} else {
  const st = lstatSync(bridge);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    st.mode & 0o077
  )
    throw new Error(
      "Start this Jelly instance first; bridge directory must be private.",
    );
  if (existsSync(manifest)) {
    const old = JSON.parse(readFileSync(manifest, "utf8"));
    if (old.path !== join(own, "launch"))
      throw new Error(
        "A different Jelly host is installed for this Chrome config. Uninstall it explicitly first.",
      );
  }
  const pairing = JSON.parse(
    readFileSync(join(bridge, "pairing.json"), "utf8"),
  );
  mkdirSync(own, { recursive: true, mode: 0o700 });
  const config = join(own, "config.json");
  writeFileSync(config, JSON.stringify({ ...pairing, extensionId: id }), {
    mode: 0o600,
  });
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(own, "launch"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "chrome-native-host.ts"))} ${quote(config)} "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(join(bridge, "extension-id"), id!, { mode: 0o600 });
  mkdirSync(join(root, "NativeMessagingHosts"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: "org.jelly.browser",
        description: "Jelly private experimental Chrome bridge",
        path: join(own, "launch"),
        type: "stdio",
        allowed_origins: [`chrome-extension://${id}/`],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "Installed org.jelly.browser for the explicitly selected Jelly instance. Connect from the extension popup.",
  );
}
