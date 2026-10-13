import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BoundedPeekabooTransport,
  PeekabooMcpClient,
  PeekabooProvider,
  MAX_DESKTOP_PAYLOAD,
  bounded,
  restrictedPeekabooEnvironment,
  validateDesktopImage,
  type DesktopProvider,
  type ProcessTarget,
  type WindowTarget,
  type ProviderObservation,
  type ProviderMutation,
  type ProviderQualification,
} from "../src/server/peekaboo";
import type { DesktopConfig } from "../src/shared/desktop";

export const syntheticConfig: DesktopConfig = {
  enabled: true,
  cliPath: "/synthetic/peekaboo",
  hostAppPath: "/synthetic/Peekaboo.app",
  bridgeSocket: "/synthetic/bridge.sock",
  allowedApps: ["com.example.SyntheticFixture"],
  captureConsent: false,
};
export const syntheticApp: ProcessTarget = {
  bundleId: "com.example.SyntheticFixture",
  pid: 123,
  processStart: "9007199254740993",
};
export const syntheticWindow: WindowTarget = {
  ...syntheticApp,
  windowId: 456,
  bounds: { x: 10, y: 20, width: 400, height: 300 },
};
export function syntheticPng(width = 1, height = 1) {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4);
    data.copy(bytes, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, bytes.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return {
    type: "image" as const,
    mimeType: "image/png" as const,
    data: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc((1 + width * 4) * height))),
      chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64"),
  };
}
export const syntheticObservation = (): ProviderObservation => ({
  target: structuredClone(syntheticWindow),
  snapshotId: "synthetic-snapshot",
  fresh: true,
  privacy: "non-sensitive",
  surface: "standard",
  elements: [
    {
      id: "button",
      role: "AXButton",
      enabled: true,
      actionable: true,
      secure: false,
      value: "PRIVATE_VALUE",
      label: "PRIVATE_LABEL",
      title: "PRIVATE_TITLE",
    },
    {
      id: "field",
      role: "AXTextField",
      enabled: true,
      actionable: true,
      valueSettable: true,
      secure: false,
      value: "PRIVATE_FIELD",
    },
  ],
});
export const syntheticQualification = (): ProviderQualification => ({
  qualified: true,
  version: "4.9.0",
  generation: "synthetic-only-listener-generation",
  identity: "synthetic-only-signed-host",
  contracts: {
    connectionBoundIdentity: true,
    generationBoundInventory: true,
    exactTargetReceipts: true,
  },
  capabilities: {
    observe: true,
    images: true,
    click: true,
    type: true,
    key: true,
    scroll: false,
    menu: false,
    foreground: false,
  },
  permissions: {
    accessibility: true,
    screenRecording: true,
    syntheticInput: true,
  },
});
export function syntheticOutcome(
  state = "confirmed_change",
  extra: Record<string, unknown> = {},
) {
  const fields: Record<string, [string, string, string, string, string]> = {
    confirmed_change: [
      "confirmed",
      "verified_change",
      "dispatched",
      "not_applicable",
      "none",
    ],
    confirmed_no_change: [
      "confirmed",
      "verified_no_change",
      "none",
      "not_applicable",
      "none",
    ],
    partial: [
      "partial",
      "primary_change_verified_cleanup_failed",
      "dispatched",
      "unsafe",
      "recover_side_effect",
    ],
    dispatched_unverified: [
      "unverifiable",
      "operation_still_running",
      "dispatched",
      "unsafe",
      "observe_before_retry",
    ],
    suspected_noop: [
      "suspected_noop",
      "observed_no_change",
      "dispatched",
      "safe",
      "refresh_target",
    ],
    refused: ["refused", "request_refused", "none", "safe", "correct_request"],
    indeterminate: [
      "unverifiable",
      "response_lost",
      "may_have_dispatched",
      "unsafe",
      "observe_before_retry",
    ],
  };
  const [effect, evidence, dispatch, retry, escalation] = fields[state]!;
  return {
    isError: !["confirmed_change", "confirmed_no_change"].includes(state),
    content: [{ type: "text", text: "PRIVATE_PROVIDER_CONTENT" }],
    _meta: {
      state,
      effect,
      evidence,
      dispatch_state: dispatch,
      retry_safety: retry,
      escalation,
      route: "bridge",
      mutation_dispatched: dispatch !== "none",
      retry_safe: retry === "safe",
      requires_fresh_observation:
        dispatch !== "none" && escalation === "observe_before_retry",
      ...(!["refused", "confirmed_no_change"].includes(state)
        ? {
            delivery_mechanism: "accessibility_action",
            delivery_mode: "background",
            target_identity: {
              kind: "window",
              pid: 123,
              window_id: 456,
              process_start_identity_decimal: syntheticApp.processStart,
            },
          }
        : {}),
      ...(state === "refused" ? { refusal_reason: "invalid_request" } : {}),
      private_detail: "PRIVATE_METADATA",
      ...extra,
    },
  };
}
export class SyntheticProvider implements DesktopProvider {
  onDisconnect?: () => void;
  calls: string[] = [];
  mutations: ProviderMutation[] = [];
  qualification: ProviderQualification = syntheticQualification();
  appRows = [structuredClone(syntheticApp)];
  windowRows = [structuredClone(syntheticWindow)];
  observation = syntheticObservation();
  outcome: unknown = syntheticOutcome();
  captureRequests: boolean[] = [];
  onObserve?: (signal: AbortSignal) => Promise<ProviderObservation>;
  onMutate?: (signal: AbortSignal) => Promise<unknown>;
  onConnect?: () => Promise<void>;
  async connect(_config: DesktopConfig, guard: () => void) {
    guard();
    this.calls.push("connect");
    await this.onConnect?.();
    guard();
    return this.qualification;
  }
  async apps(_signal: AbortSignal) {
    this.calls.push("apps");
    return structuredClone(this.appRows);
  }
  async windows(_app: ProcessTarget, _signal: AbortSignal) {
    this.calls.push("windows");
    return structuredClone(this.windowRows);
  }
  async observe(_target: WindowTarget, image: boolean, signal: AbortSignal) {
    this.calls.push("observe");
    this.captureRequests.push(image);
    const value = this.onObserve
      ? await this.onObserve(signal)
      : structuredClone(this.observation);
    if (!image && !this.onObserve) delete value.image;
    return value;
  }
  async mutate(input: ProviderMutation, signal: AbortSignal) {
    this.calls.push("mutate");
    this.mutations.push(structuredClone(input));
    return this.onMutate
      ? this.onMutate(signal)
      : structuredClone(this.outcome);
  }
  async close() {
    this.calls.push("close");
  }
}
const names = [
  "permissions",
  "app",
  "window",
  "inspect_ui",
  "see",
  "click",
  "type",
  "press",
  "scroll",
];
export const syntheticTools = names.map((name) => ({
  name,
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
}));
async function mcpFixture(
  options: {
    version?: string;
    tools?: typeof syntheticTools;
    response?: unknown;
  } = {},
) {
  const server = new Server(
    { name: "peekaboo-mcp", version: options.version ?? "4.9.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools ?? syntheticTools,
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async () =>
      (options.response ?? {
        content: [{ type: "text", text: "do not parse inventory prose" }],
        _meta: { accessibility: true },
      }) as any,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new PeekabooMcpClient(clientTransport);
  return { client, server };
}

describe("Peekaboo qualification and bounded MCP", () => {
  test("production never accepts a synthetic provider/diagnostic as release qualification", async () => {
    const provider = new PeekabooProvider();
    const result = await provider.connect(syntheticConfig, () => {});
    expect(result.qualified).toBe(false);
    await expect(provider.apps(new AbortController().signal)).rejects.toThrow(
      "official signed",
    );
    await provider.close();
  });
  test("SDK persists native _meta/content without promoting inventory prose", async () => {
    const { client, server } = await mcpFixture();
    try {
      await client.connect();
      const first = await client.call("permissions", {}),
        second = await client.call("permissions", {});
      expect(first._meta).toEqual({ accessibility: true });
      expect(second.content).toEqual(first.content);
      await expect(client.call("clipboard", {})).rejects.toThrow(
        "not negotiated",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  test("unknown MCP versions and changed closed permission schema fail", async () => {
    for (const options of [
      { version: "3.0.0-beta3" },
      { tools: syntheticTools.filter((tool) => tool.name !== "inspect_ui") },
      {
        tools: syntheticTools.map((tool) => ({
          ...tool,
          inputSchema: { ...tool.inputSchema, additionalProperties: true },
        })),
      },
    ]) {
      const { client, server } = await mcpFixture(options);
      try {
        await expect(client.connect()).rejects.toThrow();
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
  test("malformed/oversized MCP metadata, text and content fail closed", async () => {
    for (const response of [
      { content: [], _meta: [] },
      {
        content: [{ type: "text", text: "x".repeat(MAX_DESKTOP_PAYLOAD + 1) }],
      },
      {
        content: [
          { type: "resource_link", uri: "file:///private", name: "secret" },
        ],
      },
      {
        content: [{ type: "image", mimeType: "image/png", data: "not base64" }],
      },
    ]) {
      const { client, server } = await mcpFixture({ response });
      try {
        await client.connect();
        await expect(client.call("permissions", {})).rejects.toThrow();
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
  test("pre-cancel and admission recheck prevent MCP calls", async () => {
    const { client, server } = await mcpFixture();
    try {
      await client.connect();
      const controller = new AbortController();
      controller.abort();
      await expect(
        client.call("permissions", {}, controller.signal),
      ).rejects.toThrow();
      await expect(
        client.call("permissions", {}, undefined, () => {
          throw new Error("private boundary");
        }),
      ).rejects.toThrow("private boundary");
    } finally {
      await client.close();
      await server.close();
    }
  });
  test("child env does not inherit secrets or routing/unsigned overrides", () => {
    process.env.PEEKABOO_NO_REMOTE = "1";
    process.env.PEEKABOO_BRIDGE_SOCKET = "/wrong";
    process.env.SYNTHETIC_TEST_SECRET = "private";
    try {
      const env = restrictedPeekabooEnvironment();
      expect(env.PEEKABOO_NO_REMOTE).toBeUndefined();
      expect(env.PEEKABOO_BRIDGE_SOCKET).toBeUndefined();
      expect(env.SYNTHETIC_TEST_SECRET).toBeUndefined();
      expect(env.PEEKABOO_ALLOW_TOOLS).not.toContain("agent");
    } finally {
      delete process.env.PEEKABOO_NO_REMOTE;
      delete process.env.PEEKABOO_BRIDGE_SOCKET;
      delete process.env.SYNTHETIC_TEST_SECRET;
    }
  });
  test("bounded pre-parser closes on oversized and malformed stdio", async () => {
    for (const program of [
      `process.stdout.write('x'.repeat(${MAX_DESKTOP_PAYLOAD + 1})); setInterval(()=>{},1000)`,
      "process.stdout.write('not-json\\n'); setInterval(()=>{},1000)",
    ]) {
      const transport = new BoundedPeekabooTransport(process.execPath, [
        "-e",
        program,
      ]);
      const failed = new Promise<Error>((resolve) => {
        transport.onerror = resolve;
      });
      await transport.start();
      expect((await failed).message).toContain("Invalid or oversized");
      await transport.close();
    }
  });
  test("stderr has a hard redacted byte budget", async () => {
    const transport = new BoundedPeekabooTransport(process.execPath, [
      "-e",
      "process.stderr.write('PRIVATE_STDERR'.repeat(6000));setInterval(()=>{},1000)",
    ]);
    const failed = new Promise<Error>((resolve) => {
      transport.onerror = resolve;
    });
    await transport.start();
    const error = await failed;
    expect(error.message).toContain("stderr limit");
    expect(error.message).not.toContain("PRIVATE_STDERR");
    await transport.close();
  });
  test("stdio SDK uses a single restricted process for multiple calls", async () => {
    const program = `let count=0,buffer=''; process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){let m=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(m.id===undefined)continue;let result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'peekaboo-mcp',version:'4.9.0'}}:m.method==='tools/list'?{tools:${JSON.stringify(syntheticTools)}}:{content:[],_meta:{count:++count,secretPresent:!!process.env.SYNTHETIC_TEST_SECRET}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}});`;
    const client = new PeekabooMcpClient(
      new BoundedPeekabooTransport(process.execPath, ["-e", program]),
    );
    try {
      await client.connect();
      expect((await client.call("permissions", {}))._meta).toEqual({
        count: 1,
        secretPresent: false,
      });
      expect((await client.call("permissions", {}))._meta).toEqual({
        count: 2,
        secretPresent: false,
      });
    } finally {
      await client.close();
    }
  });
  test("valid native image and structured _meta survive SDK transport", async () => {
    const image = syntheticPng();
    const { client, server } = await mcpFixture({
      response: {
        content: [image],
        _meta: { coordinate_context: { reference_id: "synthetic-snapshot" } },
      },
    });
    try {
      await client.connect();
      const result = await client.call("permissions", {});
      expect(result.content).toEqual([image]);
      expect(result._meta).toEqual({
        coordinate_context: { reference_id: "synthetic-snapshot" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
  test("PNG checksum/truncation/encoding and pixels are validated without unbounded decode", () => {
    const image = syntheticPng();
    expect(validateDesktopImage(image)).toEqual(image);
    const damaged = Buffer.from(image.data, "base64");
    damaged[damaged.length - 1] ^= 1;
    expect(() =>
      validateDesktopImage({ ...image, data: damaged.toString("base64") }),
    ).toThrow("checksum");
    expect(() =>
      validateDesktopImage({
        ...image,
        data: Buffer.from(image.data, "base64")
          .subarray(0, 40)
          .toString("base64"),
      }),
    ).toThrow();
    expect(() => validateDesktopImage(syntheticPng(4097, 1))).toThrow(
      "dimensions",
    );
  });
  test("payload shape and image byte/dimension bounds are enforced", () => {
    const deep: any = {};
    let current = deep;
    for (let i = 0; i < 30; i++) current = current.child = {};
    expect(() => bounded(deep)).toThrow("structural");
    expect(() => bounded(Array(1001).fill(0))).toThrow("collection");
    expect(() =>
      validateDesktopImage({
        type: "image",
        mimeType: "image/jpeg",
        data: "aaaa",
      }),
    ).toThrow();
    const header = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.write("IHDR", 12);
    header.writeUInt32BE(5000, 16);
    header.writeUInt32BE(1, 20);
    expect(() =>
      validateDesktopImage({
        type: "image",
        mimeType: "image/png",
        data: header.toString("base64"),
      }),
    ).toThrow("dimensions");
  });
});
