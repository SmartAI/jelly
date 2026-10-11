import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import {
  ChromeFrames,
  chromeFrame,
  CHROME_MAX_FRAME,
  CHROME_PROTOCOL,
} from "../src/shared/chrome-protocol";
import {
  ChromeWriter,
  CHROME_DRAIN_TIMEOUT,
} from "../src/server/chrome-writer";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function hostFixture(stalledStdout = false) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-native-backpressure-"));
  const socketPath = join(dir, "bridge.sock");
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => {
    accept = resolve;
  });
  const server = createServer(accept);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const config = join(dir, "config.json");
  const extensionId = "a".repeat(32);
  writeFileSync(
    config,
    JSON.stringify({
      socket: socketPath,
      extensionId,
      instance: "fixture",
      grant: "fixture",
    }),
    { mode: 0o600 },
  );
  let outputFd: number | undefined;
  if (stalledStdout) {
    const fifo = join(dir, "stdout");
    execFileSync("mkfifo", [fifo]);
    outputFd = openSync(fifo, constants.O_RDWR);
  }
  const child = spawn(
    process.execPath,
    [
      "scripts/chrome-native-host.ts",
      config,
      `chrome-extension://${extensionId}/`,
    ],
    { stdio: ["pipe", outputFd ?? "pipe", "ignore"] },
  );
  // The stalled-reader case deliberately kills the host with queued stdin
  // bytes. Its writer may then receive EPIPE; that is expected shutdown, not
  // a failed timeout assertion. Other child-pipe errors remain test failures.
  child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const socket = await accepted;
  socket.on("error", () => {});
  return {
    socket,
    child,
    exited,
    async close() {
      child.kill();
      socket.destroy();
      await exited;
      if (outputFd !== undefined) closeSync(outputFd);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("native host forwards large legal frames intact in both directions under backpressure", async () => {
  const f = await hostFixture();
  try {
    const incoming = new ChromeFrames();
    const messages: unknown[] = [];
    f.socket.on("data", (data) =>
      messages.push(...incoming.push(Buffer.from(data))),
    );
    const outgoing = new ChromeFrames();
    const received: unknown[] = [];
    const reading = (async () => {
      for await (const value of f.child.stdout!.iterator({
        destroyOnReturn: false,
      })) {
        received.push(...outgoing.push(value));
        if (received.length >= 3) return;
      }
      throw new Error("Native stdout truncated");
    })();
    f.child.stdin!.write(
      chromeFrame({ type: "hello", version: CHROME_PROTOCOL }),
    );
    const payloads = [65536, 512000, CHROME_MAX_FRAME - 32].map((size) => ({
      text: "x".repeat(size),
    }));
    for (const payload of payloads) {
      f.child.stdin!.write(chromeFrame(payload));
      f.socket.write(chromeFrame(payload));
    }
    await reading;
    for (let i = 0; i < 200 && messages.length < 4; i++) await delay(10);
    expect(received).toEqual(payloads);
    expect(messages.slice(1)).toEqual(payloads);
    expect(messages[0]).toMatchObject({
      type: "hello",
      instance: "fixture",
      extensionId: "a".repeat(32),
    });
    expect(f.child.exitCode).toBeNull();
  } finally {
    await f.close();
  }
}, 15000);

test("native host times out stalled stdout and socket readers rather than buffering indefinitely", async () => {
  await Promise.all(
    ["stdout", "socket"].map(async (direction) => {
      const f = await hostFixture(direction === "stdout");
      try {
        const frame = chromeFrame({ text: "x".repeat(700000) });
        if (direction === "stdout") {
          // No stdout reader. Two frames exceed the pipe's kernel buffer.
          f.socket.write(frame);
          f.socket.write(frame);
        } else {
          // No socket reader. Keep stdin open so only the drain timeout can stop it.
          f.socket.pause();
          f.child.stdin!.write(
            chromeFrame({ type: "hello", version: CHROME_PROTOCOL }),
          );
          for (let i = 0; i < 8; i++) f.child.stdin!.write(frame);
        }
        await delay(200);
        expect(f.child.exitCode).toBeNull();
        const result = await Promise.race([
          f.exited,
          delay(CHROME_DRAIN_TIMEOUT + 3000).then(
            () => `${direction} timed out`,
          ),
        ]);
        expect(result).toBe(0);
      } finally {
        await f.close();
      }
    }),
  );
}, 15000);

test("ChromeWriter drains queued frames once in order and rejects a bounded queue overflow", async () => {
  const received: Buffer[] = [];
  let release!: () => void;
  const destination = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      received.push(Buffer.from(chunk));
      release = done;
    },
  });
  let failures = 0,
    pauses = 0,
    resumes = 0;
  const writer = new ChromeWriter(
    destination,
    () => {
      failures++;
    },
    () => {
      pauses++;
    },
    () => {
      resumes++;
    },
  );
  try {
    writer.write(Buffer.from("first"));
    writer.write(Buffer.from("second"));
    expect(received.map((b) => b.toString())).toEqual(["first"]);
    release();
    await delay(10);
    expect(received.map((b) => b.toString())).toEqual(["first", "second"]);
    release();
    await delay(10);
    expect(pauses).toBe(2);
    expect(resumes).toBe(1);
    expect(failures).toBe(0);
    const frame = chromeFrame({ text: "x".repeat(CHROME_MAX_FRAME - 32) });
    for (let i = 0; i < 5; i++) writer.write(frame);
    expect(failures).toBe(1);
  } finally {
    writer.dispose();
    destination.destroy();
  }
});
