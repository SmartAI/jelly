import { describe, expect, test } from "bun:test";
import { desktopTools } from "../src/server/desktop-tools";
import { observe, setup, deferred } from "./desktop-sessions.test";
import {
  syntheticObservation,
  syntheticOutcome,
  syntheticPng,
} from "./peekaboo.test";

const invoke = (
  tools: ReturnType<typeof desktopTools>,
  name: string,
  args: any = {},
  signal?: AbortSignal,
) =>
  tools
    .find((tool) => tool.name === name)!
    .execute("tool-call", args, signal, undefined, {} as any);

describe("desktopTools restricted run-bound map", () => {
  test("exposes exactly the ten planned closed-schema tools, no provider/configuration authority", async () => {
    const { session } = await setup({ start: false });
    const tools = desktopTools(session, "agent-a", "run-a", async () => {});
    expect(tools.map((tool) => tool.name)).toEqual([
      "desktop_status",
      "desktop_apps",
      "desktop_windows",
      "desktop_observe",
      "desktop_click",
      "desktop_type",
      "desktop_key",
      "desktop_scroll",
      "desktop_menu",
      "request_desktop_handoff",
    ]);
    for (const tool of tools) {
      const schema = tool.parameters as any;
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties)).not.toContain("agentId");
      expect(Object.keys(schema.properties)).not.toContain("cliPath");
    }
  });
  test("status is passive and omits paths, owner IDs, host generations and provider reason content", async () => {
    const { session, provider } = await setup();
    const tools = desktopTools(session, "agent-a", "run-a", async () => {});
    const status = await invoke(tools, "desktop_status");
    expect(JSON.stringify(status)).not.toContain("/synthetic");
    expect(JSON.stringify(status)).not.toContain("synthetic-only");
    expect(provider.calls).toEqual(["connect"]);
    expect(status.details).toEqual({});
  });
  test("values/raw content never appear in model tool content/details", async () => {
    const { session, provider } = await setup();
    const tools = desktopTools(session, "agent-a", "run-a", async () => {});
    const refs = await observe(session);
    provider.outcome = syntheticOutcome("partial");
    const clicked = await invoke(tools, "desktop_click", {
      elementRef: refs.elements[0].elementRef,
    });
    const serialized = JSON.stringify(clicked);
    expect(serialized).toContain("partial");
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain("process_start");
    expect(clicked.details).toEqual({});
  });
  test("qualified synthetic exact-window screenshot stays a native image, never base64 prose", async () => {
    const { session, provider } = await setup({ consent: true });
    provider.observation.image = syntheticPng();
    const refs = await observe(session);
    const tools = desktopTools(session, "agent-a", "run-a", async () => {});
    const result = await invoke(tools, "desktop_observe", {
      windowRef: refs.windowRef,
      screenshot: true,
    });
    expect(result.content.length).toBe(2);
    expect(result.content[1]).toEqual(syntheticPng());
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.stringify(result.content[0])).not.toContain(
      syntheticPng().data,
    );
    expect(provider.captureRequests.slice(-2)).toEqual([false, true]);
  });
  test("secure/unknown surface is refused before any image-producing call", async () => {
    const { session, provider } = await setup({ consent: true });
    const refs = await observe(session);
    provider.observation.privacy = "unknown";
    provider.observation.image = syntheticPng();
    const tools = desktopTools(session, "agent-a", "run-a", async () => {});
    await expect(
      invoke(tools, "desktop_observe", {
        windowRef: refs.windowRef,
        screenshot: true,
      }),
    ).rejects.toThrow();
    expect(provider.captureRequests).not.toContain(true);
  });
  test("missing scoped-scroll capability and unavailable menu refuse without calls", async () => {
    const { session, provider } = await setup();
    const tools = desktopTools(session, "agent-a", "run-a", async () => {});
    await expect(
      invoke(tools, "desktop_scroll", {
        elementRef: "foreign",
        direction: "down",
      }),
    ).rejects.toThrow("scroll capability");
    await expect(
      invoke(tools, "desktop_menu", {
        appRef: "foreign",
        action: "click",
        item: "Password",
      }),
    ).rejects.toThrow("Menu input");
    expect(provider.calls).toEqual(["connect"]);
  });
  test("handoff pauses before intervention and never echoes private reply or implicitly resumes", async () => {
    const { session } = await setup();
    await observe(session);
    let handoff = false;
    const tools = desktopTools(session, "agent-a", "run-a", async () => {
      handoff = true;
      expect(session.status().control).toBe("paused");
      return { password: "PRIVATE_INTERVENTION_REPLY" };
    });
    const result = await invoke(tools, "request_desktop_handoff", {
      reason: "Use the synthetic fixture privately",
    });
    expect(handoff).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(session.status().control).toBe("paused");
    await expect(invoke(tools, "desktop_apps")).rejects.toThrow("handback");
  });
  test("handoff cannot pause/claim another run's desktop or proceed on uncertain accepted work", async () => {
    const { session, provider } = await setup();
    const refs = await observe(session);
    let handoffs = 0;
    const foreign = desktopTools(
      session,
      "other-agent",
      "other-run",
      async () => {
        handoffs++;
      },
    );
    await expect(
      invoke(foreign, "request_desktop_handoff", { reason: "foreign" }),
    ).rejects.toThrow("busy");
    expect(session.status().control).toBe("active");
    const wait = deferred<any>(),
      entered = deferred<void>();
    provider.onObserve = async () => {
      entered.resolve();
      return wait.promise;
    };
    const pending = session.action("agent-a", "run-a", "observe", {
        windowRef: refs.windowRef,
      }),
      caught = pending.catch((error) => error);
    await entered.promise;
    const own = desktopTools(session, "agent-a", "run-a", async () => {
      handoffs++;
    });
    await expect(
      invoke(own, "request_desktop_handoff", { reason: "private" }),
    ).rejects.toThrow("unsafe");
    expect(handoffs).toBe(0);
    expect(await caught).toBeInstanceOf(Error);
    wait.resolve(syntheticObservation());
  });
  test("failed/aborted handoff stays paused with no automatic handback", async () => {
    const { session } = await setup();
    const tools = desktopTools(session, "agent-a", "run-a", async () => {
      throw new Error("form closed");
    });
    await expect(
      invoke(tools, "request_desktop_handoff", { reason: "synthetic" }),
    ).rejects.toThrow("form closed");
    expect(session.status().control).toBe("paused");
    const controller = new AbortController();
    controller.abort();
    await expect(
      invoke(
        tools,
        "request_desktop_handoff",
        { reason: "cancelled" },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(session.status().control).toBe("paused");
  });
});
