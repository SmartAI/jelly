import type { Writable } from "node:stream";
import { CHROME_MAX_FRAME } from "../shared/chrome-protocol";

export const CHROME_DRAIN_TIMEOUT = 5000;
const MAX_BUFFERED = 4 * (CHROME_MAX_FRAME + 4);

/** write(false) accepted the frame: wait for drain, never resend it. */
export class ChromeWriter {
  private queue: Buffer[] = [];
  private bytes = 0;
  private blocked = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private destination: Writable,
    private fail: () => void,
    private pause: () => void = () => {},
    private resume: () => void = () => {},
  ) {
    destination.on("drain", this.drain);
    destination.on("error", this.failure);
    destination.on("close", this.dispose);
  }
  write(frame: Buffer) {
    if (this.closed) return;
    if (
      this.bytes + this.destination.writableLength + frame.length >
      MAX_BUFFERED
    ) {
      this.failure();
      return;
    }
    this.queue.push(frame);
    this.bytes += frame.length;
    this.flush();
  }
  private flush() {
    try {
      while (!this.closed && !this.blocked && this.queue.length) {
        const frame = this.queue.shift()!;
        this.bytes -= frame.length;
        if (!this.destination.write(frame)) {
          this.blocked = true;
          this.pause();
          this.timer = setTimeout(this.failure, CHROME_DRAIN_TIMEOUT);
        }
      }
    } catch {
      this.failure();
    }
  }
  private drain = () => {
    clearTimeout(this.timer);
    this.blocked = false;
    this.flush();
    if (!this.blocked && !this.closed) this.resume();
  };
  private failure = () => {
    if (this.closed) return;
    this.dispose();
    this.fail();
  };
  dispose = () => {
    this.closed = true;
    clearTimeout(this.timer);
    this.queue = [];
    this.bytes = 0;
    this.destination.off("drain", this.drain);
    this.destination.off("error", this.failure);
    this.destination.off("close", this.dispose);
  };
}
