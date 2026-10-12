# Peekaboo integration — current Jelly web app

Status: **proposed; not implemented or Mac-validated**. This plan adds Peekaboo
support to Jelly's existing Bun backend and React web UI. It does **not** depend
on building a native Jelly Mac app or completing the native macOS roadmap.

## Scope

Run the current Jelly web app's **backend on the Mac being controlled**, alongside
an externally installed Peekaboo CLI and signed Peekaboo.app. Users continue using
Jelly through its existing web interface.

```text
Existing Jelly web UI and agent
  → typed desktop_* tools
  → run ownership and scope checks in Jelly's Bun backend
  → persistent peekaboo mcp --bridge-socket <selected socket>
  → externally installed Peekaboo.app
  → authorized Mac apps
```

The Mac needs a logged-in GUI session, macOS 15+, a compatible CLI/app pair, and
the required Accessibility, Screen Recording and synthetic-input permissions.
Peekaboo.app owns those permissions; Jelly does not need a native permission host.
Merely opening a Linux-hosted Jelly instance in a browser on a Mac does not give
its backend access to that Mac's desktop.

**Out of scope:** native Jelly packaging, Swift embedding, a Jelly-owned native
helper/daemon, driver distribution or automatic updates, remote Mac control,
alternative desktop providers, browser ports, continuous desktop streaming,
recording, clipboard access, credential automation and detached-subagent access.
The current managed-browser and Connected Chrome implementations stay unchanged
apart from necessary private-control coordination; neither is a prerequisite.

## Implementation

### 1. Connect to the installed Peekaboo host

Add `src/server/peekaboo.ts` to supervise a persistent stdio MCP client. Qualify
Peekaboo 4.9.0 as the initial candidate and document the accepted CLI/app versions
and capabilities after real-Mac testing.

- Configure an absolute CLI path and an explicitly selected Bridge socket through
  Jelly settings. These are operator configuration, never model tool arguments.
- Verify the signed executable and selected host identity; Peekaboo.app's bundle
  executable is not the CLI. Do not ask for permissions on generic Bun/Node.
- Use an established MCP client compatible with Bun. Preserve images, `_meta`,
  structured outcomes, cancellation and connection lifetime; do not shell out to
  one-shot MCPorter calls for every action.
- Spawn executable/argument arrays without a shell and with a restricted child
  environment. Keep stdout MCP-only, bound responses/stderr and redact diagnostics.
- Negotiate live capabilities and bind observations to the selected host generation.
  Never silently fall back to another socket, daemon, app or local permissions.
- Close only Jelly's client at settlement/shutdown. Do not terminate, upgrade or
  uninstall the user-owned Peekaboo host.
- Keep the model loop in Jelly: do not use `peekaboo agent`, another model provider,
  or expose the complete upstream MCP tool catalog.

### 2. Add run-bound desktop tools

Add `src/server/desktop-tools.ts`, `src/server/desktop-sessions.ts` and shared
contracts in `src/shared/desktop.ts`. Register the tools through the existing
`src/server/harness.ts` custom-tool seam, with authoritative identities supplied
by `src/server/service.ts`.

Desktop control starts **off**. The user enables it and chooses allowed native
app bundle identities. Keep it separate from `BrowserPort` and the browser target
selector; do not rename desktop actions as `browser_*`.

| Tool                      | Purpose                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `desktop_status`          | Passive configuration, permission, connection and ownership status         |
| `desktop_apps`            | Bounded inventory of allowed apps                                          |
| `desktop_windows`         | Windows of an allowed app, with opaque references                          |
| `desktop_observe`         | Exact-window accessibility map and optional screenshot                     |
| `desktop_click`           | Fresh element action; qualified window-relative pixel input when necessary |
| `desktop_type`            | Non-secret text into a freshly observed field/window                       |
| `desktop_key`             | Bounded, allowlisted keys/chords for the current exact target              |
| `desktop_scroll`          | Scoped background scrolling when the host supports it                      |
| `desktop_menu`            | Qualified, app-scoped menu listing/selection                               |
| `request_desktop_handoff` | Pause Jelly automation and ask the person to use the Mac directly          |

Start with observation and element-based click/type/key; add the remaining actions
only after their target and cancellation contracts are tested. Use background,
accessibility-first delivery by default. Foreground input requires an explicit,
expiring run grant through the existing web UI, never an automatic fallback.

Initially exclude browsers, Terminal/shells, password managers, Keychain, permission
and security settings, and Jelly/Peekaboo control surfaces. Websites remain on the
existing browser tools. Allowing an app is not blanket authorization for every
send/delete/payment operation within it; agents must follow the user's task.

### 3. Prevent conflicting or stale actions

- Allow one desktop-owning run at a time, across observe → decide → act → verify.
  Other agents get a bounded `busy` result rather than interleaving input.
- Coordinate participating Jelly instances on the same Mac using a qualified
  cross-process lease/lock. Unknown owner liveness blocks new input; never reclaim
  from a PID or stale filename alone. No new native broker is required by this plan.
- Return opaque app/window/observation/element references mapped to provider
  receipts. Bind them to run, lease, host/process/window generation and geometry.
- Invalidate references after mutations, handoff, disconnect, compaction, restart,
  lock/logout or host replacement. Never recover authority from raw PIDs/window IDs.
- Map screenshot coordinates using the returned crop/scale/coordinate context;
  never assume a fixed Retina factor or use unobserved global screen coordinates.
- Check owner, allowed app, capability, signal and fresh target before dispatch.
  Reject arbitrary provider methods, executable/socket selection, output paths,
  clipboard operations and targetless keyboard input.
- Retain provider effect/refusal/partial-dispatch evidence. `isError` or a dropped
  response does not prove that no input happened. Never replay an uncertain click,
  submission or partial text automatically; observe again and verify app state.
- Release ownership only after the complete Jelly run settles and accepted work
  drains, not at every tool turn. No automatic desktop access for detached children.

These locks constrain cooperating Jelly paths, not third-party MCP clients or
unrestricted same-user shell execution. Do not present them as an OS sandbox.

### 4. Reuse the web UI and private-handoff patterns

Add `src/client/DesktopConnection.tsx` within existing Settings/capability UI:

- Enable/disable, installed CLI/host selection, allowed apps, permission status,
  connection errors and recovery guidance.
- Current owner and target, background/foreground state, pause/stop and explicit
  resume. “Stop” revokes Jelly automation; it does not quit Peekaboo or target apps.
- Use existing authenticated control APIs and origin/CSRF checks in
  `src/server/app.ts` and `control-session.ts` for configuration and takeover.
- Extend `Interventions`/`InterventionCard` where needed and reuse `ChatFormCard`
  and `ChatFormActions`; no separate native UI or transcript focus trap.

For private handoff, close local admission immediately, cancel queued actions,
await accepted host work, invalidate observations and suppress late results before
showing that it is safe to enter credentials. Coordinate relevant existing browser
handoffs on the same Mac so desktop capture cannot bypass their pause.

A killed MCP proxy or elapsed timeout is not proof of host-side completion. If the
external host cannot establish a safe drain, show a blocked/unsafe handoff and do
not proceed with credential entry. Solving that must not silently expand this plan
into a Jelly-native host project. Cancellation, expiry and disconnect never resume
control; explicit handback requires a fresh observation.

### 5. Deliver screenshots safely

- Return validated native image blocks through Jelly's existing tool-image pipeline,
  not base64 text. Use exact-window captures, bounded AX data and AX-only reads when
  images are unnecessary. No whole-screen or implicit frontmost capture.
- Filter sensitive provider text/metadata/field values before model delivery,
  tool events, logging and persistence. Refuse known secure fields and credential
  flows; never promise that AX filtering proves every screenshot is secret-free.
- Cap image/payload dimensions and sizes within Jelly's existing limits. Read only
  validated, task-owned artifacts when filesystem staging is necessary; remove
  only those temporary files, not the user's Peekaboo caches.
- Explain in setup that screenshots can become visible, durable chat attachments
  and can be sent to the chosen model provider. Use existing history/retention rules
  and define deletion behavior before enabling personal-app captures.
- During private control, block observations/input and publication of late captures.
  Sparse/custom surfaces with unknown privacy state must fail closed.

## Delivery checklist

### A. Prove the external-host connection

- [ ] Test a matching signed CLI/app pair in a real Mac GUI session.
- [ ] Verify explicit-socket MCP connection, images, AX metadata and snapshot
      targeting under Bun, without vendor model credentials.
- [ ] Use Calculator/TextEdit and synthetic fixtures to verify visible state changes.
- [ ] Test missing permissions, host loss, partial input and pause/drain behavior;
      record accepted versions/capabilities and limitations.

### B. Implement backend tools and web controls

- [ ] Implement the adapter, run leases, reference fencing and restricted tool map.
- [ ] Register tools and settlement cleanup through the existing service/harness.
- [ ] Add Settings/status, app grants, pause/stop/resume and foreground consent.
- [ ] Add safe images and private handoff/browser coordination.
- [ ] Preserve existing browsers, image history and user-wide MCP configuration.

### C. Validate and enable

- [ ] Add fake-MCP unit tests for malformed/oversized responses, stale references,
      foreign runs, concurrent agents/instances, partial outcomes and cancellation.
- [ ] Add API/UI tests for authorization, settings, ownership, denied foreground
      grants, expired/failed handoffs and suppressed late images.
- [ ] Run opt-in Mac fixtures for background input, menus/scrolling, Retina geometry,
      moved/minimized/off-Space windows, denied permissions, lock/logout and restarts.
- [ ] Prove that unknown mutations never replay and private control never resumes
      implicitly. Precise unsupported-operation refusals are acceptable results.
- [ ] Run `bun run check` before activating code changes; use temporary data and
      synthetic fixtures, never the live database or real credentials.
- [ ] Document setup/recovery and enable only after the current-web-app integration
      passes its gates. No native app packaging or browser port is part of delivery.

## Done when

From Jelly's **existing web UI**, a user with the backend and Peekaboo installed
on the same Mac can enable scoped desktop tools, see their results, pause/revoke
control and recover from connection/permission failures. Runs cannot interleave
or reuse stale targets; uncertain actions never replay. This works without a
native Jelly app, a new Jelly-native helper, or changes to its browser architecture.

## References

- [Research](../docs/COMPUTER-USE-MACOS-RESEARCH.md).
- [Peekaboo MCP](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/MCP.md),
  [external Bridge host](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/bridge-host.md),
  [automation](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/automation.md),
  [permissions](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/permissions.md).
- [Jelly design conventions](../docs/DESIGN.md) and
  [Connected Chrome boundaries](../docs/CONNECTED-CHROME.md).
