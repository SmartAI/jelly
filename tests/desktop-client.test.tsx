await import("./dom");
import { test, expect, afterEach } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
import {
  DesktopConnection,
  DesktopHandoffCard,
} from "../src/client/DesktopConnection";
import {
  DEFAULT_DESKTOP_CONFIG,
  type DesktopUIStatus,
} from "../src/shared/desktop";
import type { Snapshot, Intervention } from "../src/shared/types";
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
function status(
  control: DesktopUIStatus["control"] = "paused",
): DesktopUIStatus {
  return {
    config: {
      ...DEFAULT_DESKTOP_CONFIG,
      enabled: true,
      allowedApps: ["com.apple.calculator"],
    },
    platformSupported: true,
    connection: "ready",
    reason: null,
    control,
    privateSafe: control === "paused",
    owner: { agentId: "agent", runId: "run" },
    target: null,
    foregroundExpiresAt: null,
    capabilities: {
      observe: true,
      images: false,
      click: false,
      type: false,
      key: false,
      scroll: false,
      menu: false,
      foreground: false,
    },
    host: null,
    permissions: {
      accessibility: true,
      screenRecording: false,
      syntheticInput: null,
    },
    handoff: {
      id: "handoff",
      agentId: "agent",
      runId: "run",
      safe: control === "paused",
    },
    browserPrivate: false,
  };
}
const handoff: Intervention = {
  id: "handoff",
  agentId: "agent",
  runId: "run",
  kind: "desktop_handoff",
  status: "pending",
  payload: { reason: "Private fixture task" },
  result: null,
  createdAt: "2026-10-01T00:00:00Z",
  expiresAt: "2026-10-01T01:00:00Z",
};
function transport(view: DesktopUIStatus) {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({
      path: input,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json(
      input.includes("control-session") ? { csrf: "fixture" } : view,
    );
  }) as typeof fetch;
  return calls;
}
test("private desktop handback requires an exact matching safely drained live request", async () => {
  for (const state of [
    "draining",
    "unsafe",
    "stopped",
    "active",
    "paused",
  ] as const) {
    transport(status(state));
    render(<DesktopHandoffCard item={handoff} onChange={() => {}} />);
    await screen.findByText(
      state === "paused"
        ? /Jelly’s accepted desktop work has drained/
        : /Pausing—do not enter credentials yet/,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Return desktop control",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(state !== "paused");
    cleanup();
  }
  transport({ ...status(), handoff: { ...status().handoff!, id: "foreign" } });
  render(<DesktopHandoffCard item={handoff} onChange={() => {}} />);
  await screen.findByText(/Pausing—do not enter credentials yet/);
  expect(
    (
      screen.getByRole("button", {
        name: "Return desktop control",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
test("desktop settings save explicit paths/app grants and cannot grant unsupported foreground", async () => {
  const calls = transport({ ...status(), handoff: null });
  render(
    <DesktopConnection
      data={
        {
          selectedAgentId: "agent",
          agents: [],
          runs: [],
        } as unknown as Snapshot
      }
      refresh={async () => {}}
    />,
  );
  await screen.findByText(/ready · paused/);
  fireEvent.change(
    screen.getByLabelText("Allowed native app bundle IDs (one per line)"),
    { target: { value: "com.apple.calculator\n\ncom.apple.TextEdit\n" } },
  );
  fireEvent.change(screen.getByLabelText("Installed CLI (absolute path)"), {
    target: { value: "/fixture/peekaboo" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save desktop settings" }),
  );
  await waitFor(() =>
    expect(calls.some((call) => call.path.endsWith("/desktop/settings"))).toBe(
      true,
    ),
  );
  expect(
    calls.find((call) => call.path.endsWith("/desktop/settings"))!.body,
  ).toMatchObject({
    cliPath: "/fixture/peekaboo",
    allowedApps: ["com.apple.calculator", "com.apple.TextEdit"],
  });
  expect(
    (
      screen.getByRole("button", {
        name: /Allow foreground/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
test("failed desktop handback cannot retain a private-safe indicator or resume itself", async () => {
  const calls = transport(status());
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    if (input.endsWith("/desktop/resume")) {
      calls.push({ path: input, body: JSON.parse(String(init?.body)) });
      return Response.json(
        { error: "Host drain unconfirmed" },
        { status: 409 },
      );
    }
    return base(input, init);
  }) as typeof fetch;
  render(
    <DesktopHandoffCard
      item={handoff}
      onChange={() => {
        throw new Error("Must not complete");
      }}
    />,
  );
  await screen.findByText(/Jelly’s accepted desktop work has drained/);
  fireEvent.click(
    screen.getByRole("button", { name: "Return desktop control" }),
  );
  await screen.findByRole("alert");
  expect(
    screen.queryByText(/Jelly’s accepted desktop work has drained/),
  ).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Return desktop control",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    calls.filter((call) => call.path.endsWith("/desktop/resume")),
  ).toHaveLength(1);
});
test("stale desktop status read cannot republish safety during an authority transition", async () => {
  let resolvePause!: (value: Response) => void;
  transport(status());
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) =>
    input.endsWith("/desktop/resume")
      ? new Promise<Response>((resolve) => {
          resolvePause = resolve;
        })
      : base(input, init)) as typeof fetch;
  render(<DesktopHandoffCard item={handoff} onChange={() => {}} />);
  await screen.findByText(/Jelly’s accepted desktop work has drained/);
  fireEvent.click(
    screen.getByRole("button", { name: "Return desktop control" }),
  );
  expect(
    screen.queryByText(/Jelly’s accepted desktop work has drained/),
  ).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Return desktop control",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await waitFor(() => expect(typeof resolvePause).toBe("function"));
  await act(async () => resolvePause(Response.json({ ok: true })));
});
