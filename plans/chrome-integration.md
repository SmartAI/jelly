# Jelly Chrome integration — source-informed implementation plan

Status: local shared-profile implementation expanded and headed-fixture tested;
not yet deployed to the normal signed-in profile. Global persistent-agent routing,
exclusive user grants, retained handoffs, scoped frames/OOPIFs and popup ownership
are implemented. Child isolation, remaining security/restart gates and public
distribution are not complete. See the implementation matrix below.

## Goal and recommendation

Let Jelly agents work in the user's normal, already-signed-in Chrome profile,
create clearly labeled task tab groups, and control only their own or explicitly
claimed tabs. Keep the existing private managed browsers available.

Build Jelly's own Manifest V3 extension and native-messaging bridge, using
Chrome's public APIs. Do not depend on ChatGPT, its MCP runtime, its native host,
or its private session metadata. Use the inspected implementation as an
architectural reference, not as code to vendor.

## Source inspected and verified behavior

Installed ChatGPT extension version: `1.26.901.11451`.

Source root:
`~/.config/google-chrome/Default/Extensions/hehggadaopoacecdllhhajmbjkdcmajg/1.26.901.11451_0/`.
Read `manifest.json`, the packaged/minified `background.js`, and
`content-scripts/codex.js`. These are installed JavaScript bundles, not the
original TypeScript repository. The native host is a compiled executable; its
implementation source was not available.

Also inspected
`/usr/lib/chatgpt/resources/plugins/openai-bundled/plugins/chrome/`:
`scripts/installManifest.mjs`, `scripts/browser-service.mjs`,
`scripts/browser-client.mjs`, `scripts/extension-ids.json`, and the packaged
tab-claiming, cleanup, session-naming, and safety documentation.

The actual mechanisms visible in source:

| Concern         | Source evidence                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport       | `Eg.connect()` calls `chrome.runtime.connectNative("com.openai.codexextension")`; `ll`/`cl` exchange bidirectional JSON-RPC requests and notifications.                    |
| Control         | `Os()` attaches `chrome.debugger` with CDP version `1.3`; `ai()` calls `chrome.debugger.sendCommand`; debugger events and detach notifications return through the bridge.  |
| Task groups     | `df.ensureAgentTabGroup()` reuses a managed group or creates one with `chrome.tabs.group`; `createGroup()` sets its title/color with `chrome.tabGroups.update`.            |
| Background work | `ri()` creates tabs with `active: false`; `xs()` creates an unfocused window when necessary. Logical task focus is separate from Chrome's foreground tab.                  |
| Ownership       | `Le` stores exclusive tab leases, with session/turn IDs, origin (`agent`/`user`), active/handoff state, and marks in `chrome.storage.session`. Mutations are serialized.   |
| User tabs       | `Rs.claimUserTab()` claims a tab without regrouping it; rejects tabs owned by another session and internal browser pages.                                                  |
| Identity        | `yf()` generates a persistent profile-instance UUID plus a browser-session generation; `gs()` combines generation and tab ID to prevent stale IDs resolving after restart. |
| Cleanup         | `Rs.endTurnUnlocked()` closes unmarked agent tabs, releases user tabs without closing them, preserves deliverables and handoffs, and detaches debuggers.                   |
| UI              | An injected isolated content script renders an agent cursor overlay; session names are short emoji-prefixed task labels.                                                   |
| Recovery        | `Eg` rejects pending calls on disconnect, reconnects via timers/alarms, and reports connection status; extension update reload is deferred while control is active.        |

The installed native-host manifest allows only OpenAI extension origins. We
must register a different host and our own extension ID; changing OpenAI's
manifest or masquerading as its extension is neither necessary nor appropriate.

Tab groups are organizational ownership cues, **not profile or cookie isolation**.
All agents using one external profile share its signed-in accounts.

## Architecture

```text
Jelly model-independent browser tools
    → BrowserSessions router
    → ChromeSessions: capabilities, ownership, run lifecycle
    → private Unix socket, per Jelly instance
    → Jelly native host: bounded length-prefixed JSON framing
    → chrome.runtime.connectNative("org.jelly.browser")
    → extension service worker
        → chrome.tabs / chrome.tabGroups
        → chrome.debugger → CDP
        → isolated scripts for observations and optional activity overlays
```

MVP runs Chrome and Jelly on the same machine. No debugging port, wildcard
listener, Chrome restart, profile copy, or ChatGPT process is required.
Browser-on-laptop/Jelly-on-server support is a separate authenticated transport
phase; loopback on a laptop does not connect to Jelly on this machine.

### Components

- `extensions/chrome/`: independently built MV3 manifest, service worker,
  typed RPC dispatcher, lease/group managers, popup, and packaged observation
  scripts. Use our own development ID/signing material.
- `scripts/chrome-native-host.ts`: a small Bun stdio relay, launched through an
  absolute executable wrapper. Validate the calling extension origin. Keep stdout
  exclusively for native-messaging frames; redact stderr diagnostics.
- `scripts/install-chrome-host.ts`: install a user-level `org.jelly.browser`
  manifest and owner-only bridge configuration without altering OpenAI entries.
- `src/server/chrome-bridge.ts`: instance-scoped Unix-socket listener, pairing,
  protocol/capability negotiation, limits, pending calls, cancellation, and events.
- `src/server/chrome-sessions.ts`: task sessions, profile selection, opaque
  tab capabilities, leases, observations, handoffs, and cleanup.
- `src/server/browser-sessions.ts`: route existing tools to managed browsers or
  external Chrome. Do not force external Chrome through `Computer`'s Xvfb/VNC
  assumptions.
- Extend `src/server/agent-tools.ts`, `service.ts`, `app.ts`, shared types,
  persistence, and client connection/handoff UI.

## Protocol and authorization

Use a versioned, schema-validated JSON-RPC protocol. Each operation carries
server-derived instance, browser-connection generation, session, run, request,
and tab-capability identifiers. The model never supplies authoritative agent/run
identity or raw CDP targets. Reject unknown methods and oversized messages.

Initial methods: handshake, begin/end session, name session, create/claim/release
tab, observe, screenshot, click, fill, key, scroll, wait, mark tab, pause/resume.
Notifications: navigation, tab removal/replacement, popup, debugger detach,
connection loss, and user pause. Low-level CDP is an internal allowlisted
transport, not a general agent tool.

Use one persistent native port per connected Chrome profile. Pair it to an
explicit Jelly instance, not whichever localhost service answers first.
Keep bridge directories owner-only and sockets restricted to the OS user.
Handshake must validate version, pairing grant, extension ID, and generation.
Bind profile identity to the authenticated connection; do not trust an arbitrary
profile ID inside a request.

Chrome native messaging uses a 32-bit native-endian byte length plus UTF-8 JSON.
Its native-host-to-extension limit is 1 MiB. Define tighter application limits
and bounded chunking for large artifacts; never forward unbounded screenshots,
page text, or event streams.

Do not expose an unauthenticated HTTP/WS browser controller. Webpages and content
scripts cannot submit control RPCs. Content-script messages must be validated
against `sender.tab`, frame/document identity, lease, and generation.

## Browser behavior

### Sessions and groups

- Select the browser profile explicitly in Jelly; do not silently attach another
  profile if the chosen one disconnects.
- One task session can span follow-up Jelly runs. Use run IDs for active-turn
  authority, and a separate stable session ID for retained handoff tabs.
- Create groups per task and window, with names such as
  `🔎 Jelly · Researcher · Supplier comparison` and stable agent colors.
- Open new tabs in the background. Focus a real Chrome tab/window only when the
  user requests it or a documented operation requires it.
- Groups never establish authority. Every action checks an exclusive tab lease
  in both the server and extension. Different agents can operate different tabs.
- Claim existing user tabs only through an explicit user selection/grant.
  Preserve their existing group and never close them during automatic cleanup.
- Track popups only when their opener is an owned tab and the current run is
  still authorized. Recheck destination access before observing or acting.

### Observations and control

- Use `chrome.debugger` for target-scoped CDP screenshots, input, navigation,
  frame tracking, and DOM/accessibility observations.
- Adapt Jelly's bounded visible-text, exact-node-reference, and secret-field
  rules into an extension/CDP implementation. Existing Playwright
  `ElementHandle` references cannot simply be reused.
- References bind to connection, tab, frame/document, and observation epochs;
  navigation, detach, replacement, handoff, or reconnect invalidates them.
- Support same-process frames and out-of-process child frames; authorize their
  origins before exposing content. Do not attach unrelated browser targets.
- Return images as native tool image content, not base64 text in model output.
- Keep account credentials in Chrome. Do not read cookie stores, browser
  passwords, autofill databases, or browser storage through agent tools.
- Do not expose arbitrary evaluation, network bodies, browser history, bookmarks,
  or unbounded browser API access in the MVP.
- File uploads/download export need a separate reviewed artifact protocol.
  Unsupported capabilities must report unavailable rather than silently fall
  back to filesystem/profile access.

### Cleanup and private handoffs

- Temporary agent tabs close when the complete Jelly run settles.
- Deliverable tabs remain open but lose agent control; handoff tabs remain
  reserved, paused, and can be explicitly resumed.
- Claimed user tabs are released and remain open.
- Cleanup occurs after `Harness.settle()`/child disposal, not at every Pi
  `turn_end`: Jelly has tool turns, steering, and async child continuations.
- Child browser sessions need their own authenticated identity and leases;
  never inherit unrestricted parent tab access.
- Pause/revoke authority locally in the extension before sending a takeover
  notification. Block observations, screenshots, events, and actions during
  credential entry; detach the debugger and discard retained observations.
- Reuse Jelly's `ChatFormCard`/intervention pattern for sign-in and handback.
  External Chrome handoff happens in the user's actual browser, not VNC.
- Chrome debugger cancellation or DevTools takeover pauses the session; do not
  fight another debugger or automatically reattach after user cancellation.
- Disconnects make in-flight mutations indeterminate. Re-observe on recovery;
  never automatically replay clicks, typing, submissions, or destructive actions.
- Server/browser restart revokes old capabilities. Reconcile retained tabs only
  after re-pairing/revalidation; never restore active authority from numeric IDs.

## UI and permission model

Keep browser **target** separate from managed browser **controller**:
`Managed browser` versus `Connected Chrome`; Playwright/AgentBrowser remains a
managed-controller choice. Capture the chosen target for each allocated session;
settings changes cannot switch an active run or private handoff underneath it.

Jelly UI: connection/profile status, target selector, task group/tab status,
open-in-Chrome, pause, resume, and disconnect. Extension popup: paired instance,
working agents, owned tabs, and an always-reachable local pause/disconnect.
Defer full side-panel chat; it is not necessary for good browser control.

Request only needed permissions: `nativeMessaging`, `debugger`, `tabs`,
`tabGroups`, `storage`, `scripting`, `alarms`, and applicable navigation events.
Choose host permissions based on the observation implementation; explain their
scope and enforce site policy even where debugger permission is broad.
History/bookmarks and optional download capabilities stay out of the MVP.

Enforce user-approved site scope and task authority at navigation, redirected
documents, frames, and action time. Protect Jelly UI/control origins, extension
pages, internal browser pages, and browser security settings.
An external normal profile does not inherit the managed browser's SOCKS egress
gate: do not claim equivalent network isolation. Audit sensitive endpoints,
service-worker requests, redirect races, and navigation protection before rollout.
Treat page content as untrusted, and retain private credential handoffs.

## Delivery phases

### 1. Vertical slice

- [x] Build an unpacked extension, install our separate native host, and pair one
      test profile to Jelly over a private socket.
- [x] Create/name a background task tab group.
- [x] Open a local fixture, observe it, click/fill a harmless control, and return
      a screenshot through a native Jelly tool.
- [x] Implement local pause, disconnect, and tab-lease checks before testing any
      signed-in normal profile.

Exit: actual Chrome actions work without ChatGPT, MCP, X11 screen control, or
remote-debugging flags.

### 2. Jelly integration and ownership

- [x] Add profile/target selection and session routing without regressing managed
      browser engines, profiles, or VNC.
- [x] Implement user-tab claiming, groups, popups, generations, exact references,
      deliverables, and handoffs.
- [x] Wire stop/failure/shutdown and run settlement to explicit cleanup.
- [x] Verify parent/child identity propagation; keep unsupported child access
      unavailable until isolation is implemented.

### 3. Production hardening and distribution

- [ ] Test frame/redirect policy, credential suppression, restart reconciliation,
      service-worker suspension, version mismatch, slow peers, framing/chunk limits,
      debugger conflicts, and indeterminate mutations.
- [x] Test two agents, two profiles, and two Jelly instances without lease or
      message crossover. Groups alone are not an isolation test.
- [ ] Exercise user tab regrouping/removal, group deletion, tab replacement,
      stale IDs, popup races, and human handoff during an in-flight action.
- [ ] Build installers and uninstall support that preserve unrelated native hosts;
      publish/sign the extension after the unpacked developer build passes.
- [x] Run real headed-Chrome tests with temporary profiles/local fixture sites,
      tool-image/UI tests, all managed-browser regressions, and `bun run check`.
- [ ] Deploy using Jelly's queued idle restart procedure; separately verify
      loopback and Tailscale access afterward.

## Implementation / remaining-work matrix

The design above is retained; checked phases do not imply signed-in rollout
approval. See [Connected Chrome](../docs/CONNECTED-CHROME.md) for exact setup,
permission boundaries, supported tools and the latest validation commands.

| Requirement | Implementation and evidence | Remaining |
| --- | --- | --- |
| All persistent agents, one explicit shared profile | Global persisted selection and pinned router; managed target preserved; settings/setup UI | Operator installation/global activation after review; children excluded explicitly |
| Native transport / own identity | Private instance socket, protocol v2, bounded frames/events/writers; fixed Jelly development manifest key; installer/uninstaller preserve unrelated hosts | Public signing/store credentials and cross-platform distribution |
| Task/window groups and leases | Stable agent colors, model-supplied short task name, background groups, exclusive per-tab capabilities in both layers | Group labels do not isolate cookies/accounts |
| User tabs | Packaged-popup explicit task/tab grant; no model tab inventory; original grouping preserved; close/settlement release rather than close | Normal signed-in profile not exercised |
| Handoffs / cleanup | Complete-run settlement; temporary, deliverable and retained paused handoff states; fresh run binding and explicit resume; private controls gated on matching reservation and acknowledged pause, not early intervention publication | Retained reservations intentionally revoked on transport/process loss |
| Observations / input | Bounded visible text and exact document refs; scoped same-process/OOPIF scripts; PNG, fill/click/select/key/scroll/waits; all-document secret guards; extension-only bounded open/closed-root detection rejects entire documents, with real secret/nonempty/editable closed-root regressions | Shadow DOM, hidden/clipped/srcdoc/embedded documents and free coordinates/typing remain unsupported; transient capture secrecy is not proven |
| Popups / navigation | Opener-derived exclusive adoption with site checks, redirect DNR and stale-document invalidation | Popup traffic can precede notification; no SOCKS-equivalent claim |
| Human takeover | Authority revocation and acknowledged pause are separate server/UI states; preparation/drain/resume disables private controls; rejected debugger detach preserves attachment and reports failure; stale polls and late Resume ACKs cannot restore safe/active status; protocol-v3 events bind to the current run; headed rejected-detach and delayed capture/fill drain tests | Exhaustive attach/render/credential interleavings and transient screenshot secrecy audit; admitted mutations may finish before acknowledgement |
| Recovery | Disconnect/worker restart revokes; persisted cleanup-only debugger obligations block reconnect/regrant until confirmed detach; headed failure → disconnect → worker recreation → fresh grant regression; replacement revokes rather than transferring numeric IDs; last retained-tab closure prunes idle sessions (ten-cycle regression) | Live replacement/prerender and full server/browser/update/suspension matrix |
| Child sessions | Full Pi SDK/extensions docs and separate child provider boundary reviewed; parent/foreign identities rejected | Authenticated per-child IPC/lifecycle adapter not implemented; no inherited parent browser tools |
| Validation | Real headed temporary Chrome/native-host tests, simultaneous agents and two profiles/instances, user grants, OOPIF targets, handoff, popup, pause races, version mismatch and worker termination | Not a signed-in-profile test or proof of all security gates |
| Deferred MVP work | File artifact transport, remote transport, side panel/overlays, public distribution separated explicitly | Requires separate reviewed protocol/distribution work |

## References

- [OpenAI browser extension documentation](https://learn.chatgpt.com/docs/chrome-extension)
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome debugger/CDP transport](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome tab groups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
- [Existing Jelly browser boundaries](../docs/BROWSER-CONTROLLERS.md)
