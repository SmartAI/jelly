import type { Computer } from "./computer";
import type { ComputerSessions } from "./computer-sessions";
import type { ChromeSessions } from "./chrome-sessions";
import type { ChromeSelection } from "../shared/chrome-protocol";
export interface BrowserPort {
  target?: "managed" | "chrome";
  keepTab?: (mark?: "deliverable" | "handoff") => Promise<unknown>;
  action(
    method: Parameters<Computer["action"]>[0] | "name" | "select",
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): ReturnType<Computer["action"]>;
  reserveLogin(id: string, url: string, signal?: AbortSignal): Promise<unknown>;
  cancelLogin(id: string): void;
}
/** Target/profile choices are pinned at allocation, separately from managed controllers. */
export class BrowserSessions {
  private pins = new Map<string, ChromeSelection>();
  constructor(
    private managed: ComputerSessions,
    readonly chrome: ChromeSessions,
  ) {}
  forRun(
    agent: string,
    run: string,
    selection: ChromeSelection,
    name: string,
  ): { target: "managed" | "chrome"; get(id: string): BrowserPort } {
    const captured = structuredClone(selection);
    let pin = this.pins.get(agent);
    if (!pin) {
      pin =
        this.managed.state(agent).status !== "stopped"
          ? { ...captured, browserTarget: "managed" }
          : captured;
      this.pins.set(agent, pin);
    }
    const selected = pin;
    let port: BrowserPort | undefined;
    return {
      target: selected.browserTarget,
      get: (id) => {
        if (id !== agent)
          throw new Error(
            "Child/foreign Chrome browser access is unavailable.",
          );
        if (port) return port;
        if (selected.browserTarget === "chrome")
          return (port = this.chrome.allocate(agent, run, selected, name));
        const computer = this.managed.get(agent);
        return (port = {
          target: "managed",
          action: (method, params, signal) => {
            if (method === "name" || method === "select")
              throw new Error("Operation requires Connected Chrome.");
            return computer.action(method, params, signal);
          },
          reserveLogin: (id, url, signal) =>
            computer.reserveLogin(id, url, signal),
          cancelLogin: (id) => computer.cancelLogin(id),
        });
      },
    };
  }
  target(agent: string) {
    return this.pins.get(agent)?.browserTarget;
  }
  releasePin(agent: string) {
    this.pins.delete(agent);
  }
}
