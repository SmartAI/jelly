export {};
// Production owns native loopback/Tailscale HTTP listeners in startApp.
const api = Bun.spawn([process.execPath, "src/server/index.ts"], {
  env: {
    ...process.env,
    JELLY_DEV: "0",
    JELLY_PORT: process.env.JELLY_PORT ?? "5173",
  },
  stdout: "inherit",
  stderr: "inherit",
});
let stopping = false;
const stop = () => {
  if (!stopping) {
    stopping = true;
    api.kill();
  }
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.exit(await api.exited);
