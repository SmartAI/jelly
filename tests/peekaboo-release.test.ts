import { describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import appsWire from "./fixtures/peekaboo-4.9.0/apps.json";
import windowsWire from "./fixtures/peekaboo-4.9.0/windows.json";
import observationWire from "./fixtures/peekaboo-4.9.0/inspect-ui.json";
import deliveredWire from "./fixtures/peekaboo-4.9.0/delivery-accepted.json";
import {
  PeekabooMcpClient,
  ReleasedPeekabooSession,
  releasedApps,
  releasedWindows,
  releasedObservation,
  type ProviderMutation,
} from "../src/server/peekaboo";
import { desktopMutationOutcome } from "../src/server/desktop-sessions";
import {
  syntheticApp,
  syntheticWindow,
  syntheticConfig,
  syntheticTools,
  syntheticPng,
  SyntheticProvider,
} from "./peekaboo.test";
import { setup, observe } from "./desktop-sessions.test";

const signal = () => new AbortController().signal;
function nativeProvider() {
  const provider = new SyntheticProvider();
  if (!provider.qualification.qualified) throw new Error("fixture");
  provider.qualification.contracts = {
    nativePinnedConnection: true,
    discoveryOnlyInventory: true,
    exactTargetReceipts: true,
  };
  provider.qualification.capabilities.scroll = true;
  provider.observation = releasedObservation(
    structuredClone(observationWire),
    syntheticWindow,
  );
  provider.outcome = structuredClone(deliveredWire);
  return provider;
}

async function wireSession() {
  const commands: string[][] = [],
    calls: { name: string; args: Record<string, unknown> }[] = [];
  let hostChanged = false,
    failInput = false;
  const server = new Server(
    { name: "peekaboo-mcp", version: "4.9.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: syntheticTools,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push({
      name: request.params.name,
      args: request.params.arguments ?? {},
    });
    if (request.params.name === "inspect_ui")
      return structuredClone(observationWire);
    if (request.params.name === "see")
      return {
        ...structuredClone(observationWire),
        content: [syntheticPng()],
        _meta: {
          ...structuredClone(observationWire._meta),
          coordinate_context: {
            reference_id: observationWire._meta.snapshot_id,
          },
        },
      };
    if (failInput) throw new Error("PRIVATE_LOST_INPUT_RESPONSE");
    return structuredClone(deliveredWire);
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new PeekabooMcpClient(clientTransport);
  await client.connect();
  const session = new ReleasedPeekabooSession(syntheticConfig.allowedApps, {
    command: async (args) => {
      commands.push(args);
      return structuredClone(args[0] === "app" ? appsWire : windowsWire);
    },
    call: (name, args, signal) => client.call(name, args, signal),
    guardHost: async () => {
      if (hostChanged) throw new Error("Host replaced");
    },
  });
  return {
    session,
    calls,
    commands,
    replaceHost: () => {
      hostChanged = true;
    },
    loseInput: () => {
      failInput = true;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("official Peekaboo 4.9.0 released wire", () => {
  test("CLI JSON lossless generations and geometry are discovery, not parsed prose", () => {
    expect(releasedApps(appsWire, syntheticConfig.allowedApps)).toEqual([
      syntheticApp,
    ]);
    expect(releasedWindows(windowsWire, syntheticApp)).toEqual([
      syntheticWindow,
    ]);
    expect(
      JSON.stringify(releasedApps(appsWire, syntheticConfig.allowedApps)),
    ).not.toContain("PRIVATE");
    expect(
      JSON.stringify(releasedWindows(windowsWire, syntheticApp)),
    ).not.toContain("PRIVATE");
    const missing = structuredClone(appsWire) as any;
    delete missing.data.apps[0].process_start_identity_decimal;
    expect(() => releasedApps(missing, syntheticConfig.allowedApps)).toThrow(
      "lossless",
    );
    missing.data.apps[0].process_start_identity_decimal =
      "18446744073709551616";
    expect(() => releasedApps(missing, syntheticConfig.allowedApps)).toThrow(
      "lossless",
    );
    expect(releasedApps(appsWire, [])).toEqual([]);
  });
  test("wrong owner, duplicate windows and malformed geometry refuse before observation", () => {
    for (const alter of [
      (wire: any) => {
        wire.data.target_application_info.bundle_id = "com.apple.Safari";
      },
      (wire: any) => {
        wire.data.windows.push(wire.data.windows[0]);
      },
      (wire: any) => {
        wire.data.windows[0].bounds.width = 0;
      },
      (wire: any) => {
        delete wire.data.inventory_completeness;
      },
    ]) {
      const wire = structuredClone(windowsWire);
      alter(wire);
      expect(() => releasedWindows(wire, syntheticApp)).toThrow();
    }
  });
  test("native exact receipts retain unknown completeness/privacy without fabricated bounds or secure=false", () => {
    const result = releasedObservation(observationWire, syntheticWindow);
    expect(result.target).toEqual({
      ...syntheticApp,
      windowId: syntheticWindow.windowId,
    });
    expect(result.complete).toBeNull();
    expect(result.privacy).toBe("unknown");
    expect(result.surface).toBe("unknown");
    expect(result.nativeSnapshot).toBe(true);
    expect(result.elements[0]?.secure).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const noFresh = structuredClone(observationWire) as any;
    delete noFresh._meta.used_cache;
    expect(releasedObservation(noFresh, syntheticWindow).fresh).toBe(false);
  });
  test("missing, stale, contradictory and oversized public receipts cannot become references", () => {
    for (const alter of [
      (wire: any) => {
        delete wire._meta.target_receipt;
      },
      (wire: any) => {
        wire._meta.target_receipt.process_start_identity_decimal = "9";
      },
      (wire: any) => {
        wire._meta.target_receipt.window_id++;
      },
      (wire: any) => {
        wire._meta.target_identity = { ...wire._meta.target_receipt, pid: 9 };
      },
      (wire: any) => {
        wire._meta.snapshot_id = "legacy-raw-snapshot";
      },
      (wire: any) => {
        wire._meta.ui_elements = Array(201).fill(wire._meta.ui_elements[0]);
      },
      (wire: any) => {
        wire._meta.ui_elements.push(wire._meta.ui_elements[0]);
      },
      (wire: any) => {
        wire._meta.state = "dispatched_unverified";
      },
      (wire: any) => {
        wire.content.push(syntheticPng());
      },
    ]) {
      const wire = structuredClone(observationWire);
      alter(wire);
      expect(() => releasedObservation(wire, syntheticWindow)).toThrow();
    }
  });
  test("actual SDK _meta drives background snapshot input; no query, targetless, foreground or replay", async () => {
    const fixture = await wireSession();
    try {
      expect(await fixture.session.apps(signal())).toEqual([syntheticApp]);
      expect(await fixture.session.windows(syntheticApp, signal())).toEqual([
        syntheticWindow,
      ]);
      for (const mutation of [
        { kind: "click", elementId: "B1" },
        { kind: "type", elementId: "T1", text: "Synthetic text" },
        { kind: "key", key: "Shift+Tab", count: 1 },
        { kind: "scroll", elementId: "G1", direction: "down", amount: 2 },
      ] as const) {
        const observed = await fixture.session.observe(
          syntheticWindow,
          false,
          signal(),
        );
        const input: ProviderMutation = {
          ...mutation,
          target: observed.target,
          snapshotId: observed.snapshotId,
        };
        await fixture.session.mutate(input, signal());
        const sent = fixture.calls.at(-1)!;
        expect(sent.args.snapshot).toBe(observed.snapshotId);
        expect(sent.args.query).toBeUndefined();
        expect(sent.args.app).toBeUndefined();
        expect(sent.args.pid).toBeUndefined();
        expect(sent.args.foreground).not.toBe(true);
        const count = fixture.calls.length;
        await expect(fixture.session.mutate(input, signal())).rejects.toThrow(
          "no replay",
        );
        expect(fixture.calls.length).toBe(count);
      }
      expect(
        fixture.calls.find((call) => call.name === "type")?.args.clear,
      ).toBe(false);
      expect(
        fixture.calls.find((call) => call.name === "press")?.args.keys,
      ).toEqual(["shift+Tab"]);
    } finally {
      await fixture.close();
    }
  });
  test("image coordinates require the exact current capture-owned reference", async () => {
    const fixture = await wireSession();
    try {
      const observed = await fixture.session.observe(
        syntheticWindow,
        true,
        signal(),
      );
      expect(observed.image).toEqual(syntheticPng());
      await fixture.session.mutate(
        {
          kind: "click",
          target: observed.target,
          snapshotId: observed.snapshotId,
          coordinates: { x: 0, y: 0 },
        },
        signal(),
      );
      expect(fixture.calls.at(-1)?.args).toEqual({
        snapshot: observed.snapshotId,
        coordinate_reference: observed.snapshotId,
        coordinate_space: "image_pixels",
        coords: "0,0",
        foreground: false,
        wait_for: 0,
      });
    } finally {
      await fixture.close();
    }
  });
  test("host replacement and lost response never fall back or replay", async () => {
    const fixture = await wireSession();
    try {
      const observed = await fixture.session.observe(
        syntheticWindow,
        false,
        signal(),
      );
      fixture.loseInput();
      const input: ProviderMutation = {
        kind: "click",
        elementId: "B1",
        target: observed.target,
        snapshotId: observed.snapshotId,
      };
      await expect(fixture.session.mutate(input, signal())).rejects.toThrow();
      await expect(fixture.session.mutate(input, signal())).rejects.toThrow(
        "no replay",
      );
      expect(
        fixture.calls.filter((call) => call.name === "click"),
      ).toHaveLength(1);
      fixture.replaceHost();
      await expect(
        fixture.session.observe(syntheticWindow, false, signal()),
      ).rejects.toThrow("Host replaced");
    } finally {
      await fixture.close();
    }
  });
  test("pre-aborted discovery sends nothing", async () => {
    const fixture = await wireSession();
    try {
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(fixture.session.apps(cancelled.signal)).rejects.toThrow();
      expect(fixture.commands).toHaveLength(0);
      expect(fixture.calls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
  test("healthy native delivery acceptance permits verification; still-running and partial work do not", () => {
    expect(
      desktopMutationOutcome(deliveredWire, syntheticWindow, true).unsafe,
    ).toBe(false);
    expect(desktopMutationOutcome(deliveredWire, syntheticWindow).unsafe).toBe(
      true,
    );
    const pending = structuredClone(deliveredWire);
    pending._meta.evidence = "operation_still_running";
    expect(desktopMutationOutcome(pending, syntheticWindow, true).unsafe).toBe(
      true,
    );
  });
});

describe("DesktopSessions released native snapshot contract", () => {
  test("unknown global privacy does not disable scoped native input or leak raw content", async () => {
    const provider = nativeProvider();
    const { session } = await setup({ provider });
    const refs = await observe(session);
    expect(refs.privacy).toBe("unknown");
    expect(refs.completeness).toBe("unknown");
    expect(JSON.stringify(refs)).not.toContain("PRIVATE");
    expect(JSON.stringify(refs)).not.toContain("ps1_");
    const clicked = await session.action("agent-a", "run-a", "click", {
      elementRef: refs.elements[0].elementRef,
    });
    expect((clicked.data as any).unsafe).toBe(false);
    expect(session.status().control).toBe("active");
    await expect(
      session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
    ).rejects.toThrow();
    expect(provider.mutations).toHaveLength(1);
    await observe(session); // Fresh verification is available, no blind replay.
  });
  test("native scroll uses a run-bound fresh element and invalidates it", async () => {
    const provider = nativeProvider();
    const { session } = await setup({ provider });
    const refs = await observe(session);
    await session.action("agent-a", "run-a", "scroll", {
      elementRef: refs.elements[2].elementRef,
      direction: "down",
      amount: 3,
    });
    expect(provider.mutations[0]?.kind).toBe("scroll");
    expect(provider.mutations[0]?.elementId).toBe("G1");
    await expect(
      session.action("agent-a", "run-a", "scroll", {
        elementRef: refs.elements[2].elementRef,
        direction: "down",
      }),
    ).rejects.toThrow();
  });
  test("unknown completeness permits consented image, but known secure AX refuses before pixels", async () => {
    const provider = nativeProvider();
    provider.observation.image = syntheticPng();
    provider.observation.coordinateReference = provider.observation.snapshotId;
    const { session } = await setup({ provider, consent: true });
    const refs = await observe(session, true);
    expect(refs.image).toEqual(syntheticPng());
    expect(refs.coordinateInput).toBe(true);
    await expect(
      session.action("agent-a", "run-a", "click", {
        observationRef: refs.observationRef,
        x: 1,
        y: 0,
      }),
    ).rejects.toThrow("in-image");
    await session.action("agent-a", "run-a", "click", {
      observationRef: refs.observationRef,
      x: 0,
      y: 0,
    });
    expect(provider.mutations[0]?.coordinates).toEqual({ x: 0, y: 0 });
    provider.observation.privacy = "secure";
    const previous = provider.captureRequests.filter(Boolean).length;
    await expect(observe(session, true)).rejects.toThrow("secure");
    expect(provider.captureRequests.filter(Boolean)).toHaveLength(previous);
  });
  test("stale native observations remain read-only and cannot supply input authority", async () => {
    const provider = nativeProvider();
    provider.observation.fresh = false;
    const { session } = await setup({ provider });
    const refs = await observe(session);
    expect(refs.fresh).toBe(false);
    await expect(
      session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
    ).rejects.toThrow("Fresh");
    expect(provider.mutations).toHaveLength(0);
  });
  test("lost accepted native input quarantines and blocks private handoff without replay", async () => {
    const provider = nativeProvider();
    provider.onMutate = async () => {
      throw new Error("PRIVATE_LOSS");
    };
    const { session } = await setup({ provider });
    const refs = await observe(session);
    await expect(
      session.action("agent-a", "run-a", "click", {
        elementRef: refs.elements[0].elementRef,
      }),
    ).rejects.toThrow("unknown");
    expect(session.status().control).toBe("unsafe");
    expect((await session.pause()).privateSafe).toBe(false);
    expect(provider.mutations).toHaveLength(1);
  });
});
