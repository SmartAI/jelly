# Apps — a home for things built with Jelly

Status: implemented and independently reviewed, with integrated automated and disposable Linux/systemd/Tailscale acceptance. Initial production activation completed through the idle helper on 2026-10-11 at 16:16:42; loopback and private Tailscale HTTP were verified from this host. Follow-up patches use the same idle-restart and health-check procedure; its journal records the current activation result. Actual host reboot and real phone/Safari verification are not performed; see evidence and limits below.

## Product decisions

- Add two first-class destinations: **Apps** and **Agents**. Apps is the launcher; Agents retains the existing project/inbox/chat experience.
- `/apps` is the Apps Home Screen. Restore the last destination on ordinary visits; explicit app and conversation links take precedence. Do not unexpectedly move existing users out of Agents.
- Apps are persistent web applications, not transcript HTML previews, remote-browser sessions, or temporary development servers.
- On Linux, each managed app runs as a persistent **systemd user service**, on allocated ports, reachable locally and privately over Tailscale.
- Default launch is inside a minimal Jelly-owned app viewer. A small, always-available home control returns to Apps even if the app crashes.
- App processes survive agent completion, browser closure, and Jelly restarts. No public publishing or Tailscale Funnel.

## Home Screen

Split Home into two sections: **Starred** at the top and **History** below. Frequently used apps stay prominent; one-off apps remain easy to revisit without filling the icon grid. Follow Jelly theme, spacing, motion, and accessibility conventions.

### Starred

Use a spacious, responsive grid of rounded-square icons with short names underneath, rather than dashboard cards full of technical details. Start with three columns on narrow phones and adapt to available space. Only starred apps appear in this grid, always above History. Order by `starredAt` descending (most recently starred first), with a stable ID tie-breaker. Opening an app updates its last-opened time but never its starred time or position in this grid; renames and health updates do not reshuffle favorites.

### History

Show unstarred apps as compact rows, one per app, ordered by `COALESCE(lastOpenedAt, createdAt)` descending, with a stable ID tie-breaker. Opening a historical app moves it to the top of History immediately. Newly created apps enter at the top using their creation time until first opened. Each row shows a small icon, app name, and relative last-opened time, or “Not opened yet.” This is a launcher history, not a log of every visit; starred apps are not duplicated here. Paginate/load more as the history grows.

Record launches through Jelly's tile/row, viewer entry, and direct-launch actions; deduplicate a single navigation and do not count health checks, prefetches, iframe internal navigation, or deployments as visits. Direct bookmarks to an app outside Jelly are not tracked in v1. Record launch intent, not proof of successful rendering.

### Shared controls and starring

Both tiles and rows have:

- App icon and name; a generated initial/color fallback until an icon is supplied.
- An understated status indicator only when stopped, starting, or unhealthy.
- An accessible **Star/Unstar** toggle, separate from the launch target, usable by touch and keyboard without opening the app. Expose the toggle state with `aria-pressed` and keep action targets at least 44px.
- A separate accessible overflow action for **Details**, **Open in new tab**, **Edit with agent**, **Start/Stop/Restart**, and **Remove from Apps**.

New apps are unstarred by default. Starring sets `starredAt` and moves an app to the front of the top grid immediately; unstarring clears `starredAt` and returns it to its chronological position in History without changing its last-opened time. Starring an already-starred app is idempotent and preserves its timestamp; unstarring and then starring again assigns a new timestamp. Preserve keyboard focus across the move and announce the changed state; restore the previous state and show a retryable error if saving fails. Persist stars server-side so they survive reloads and appear consistently across devices.

Starring is an organizational preference, not a service-lifecycle policy: unstarred/one-off apps are not automatically stopped, deleted, or expired. Existing Stop/Uninstall/Remove controls remain explicit. Agents must not auto-star apps merely because they created or deployed them.

If no apps are starred, show a compact “Star apps to keep them here” hint above History rather than an empty grid. If only starred apps exist, omit the empty History section.

The header provides Apps/Agents navigation and **Build an app**. Keep search lightweight; no folders, marketplace, widgets, or drag-and-drop ordering in v1.

Empty state: “Your apps live here. Ask Jelly to build something.” Build an app selects or creates an agent/project and opens a normal conversation with an app-building intent. It does not silently launch a model request.

Details shows description, linked project/agent, local and Tailscale URLs, service state, health-check time, and sanitized diagnostics. Technical fields are secondary. An unavailable app remains in its grid or history position with a useful recovery screen, not a blank browser error.

Switching between Apps and Agents preserves chat drafts, selected project/agent, scroll position, unread counts, and active work. Removing or archiving the builder agent must not delete the app.

## Visiting an app and getting home

### Default: Jelly-owned viewer

`/apps/:id` opens a full-viewport, cross-origin iframe with no agent sidebar or permanent toolbar.

- A small floating **Jelly home** pill sits at the top-left, with a visible home mark and a minimum 44px hit target.
- It is rendered by Jelly, outside the iframe: the app cannot accidentally remove it or make it disappear during loading.
- It returns explicitly to `/apps`, restores Home scroll, and focuses the originating tile or history row by app ID, even if its position changed. Do not implement this as `history.back()`: the app may have navigated many times.
- Keep it lightly styled but discoverable. Never require a hover, swipe, long press, or undocumented keyboard shortcut.
- Respect safe-area insets. Reserve a small corner clearance in generated apps; provide a configurable alternate corner for apps whose controls conflict.
- An adjacent compact menu offers app details and **Open in new tab**. No chat composer overlays the app.
- Browser Back/Forward, reload, and deep links must work. Iframe history can affect browser Back; explicit home remains deterministic.

Generated apps receive a tiny optional Jelly bridge for readiness and internal-route reporting. Persist only validated relative routes for shareable viewer deep links; do not copy tokens or arbitrary query strings into Jelly URLs. Validate every bridge message's origin, source window, app identity, and schema. No arbitrary commands or control credentials cross this bridge.

Use sandbox and permissions-policy restrictions: allow the scripts, forms, and origin behavior needed by the app, but deny top-level navigation and unrestricted popups by default. Grant additional capabilities explicitly. Do not force existing apps to remove security headers merely to make embedding work.

### Direct access and incompatible apps

Some apps require top-level OAuth, browser capabilities, or forbid framing. Support a recorded `launchMode: direct` and a visible direct-launch fallback; iframe `load` alone is not proof that an app rendered successfully.

The generated-app template also includes a lightweight **Jelly home** link for direct visits, hidden when running in the validated viewer. Use configured local/Tailscale Jelly origins and an allowlisted return destination, never an arbitrary return URL. This makes a bookmarked app usable without first visiting Jelly.

For an imported app without the integration, open directly in a new tab and keep Apps in the original tab. Be explicit: Jelly cannot guarantee an in-page home button on an arbitrary external page. Fullscreen app content can also obscure parent UI; do not allow fullscreen by default.

## Registry and lifecycle

Add an instance-scoped SQLite app registry, accessed through a server service layer. Agents must not edit the database directly.

Suggested record:

```text
id, slug, name, description, iconAssetId
projectId?, builderAgentId?, sourceDirectory
managementMode: managed | linked
launchMode: embedded | direct
runtimeSocket?, gatewayPort?, unitName?, deploymentRevision?
executable?, args?, healthPath?
localOrigin?, tailnetOrigin?, allowedJellyOrigins
desiredState, starredAt?, lastOpenedAt?, createdAt, updatedAt
```

Star preferences are instance-scoped in v1, matching Jelly's current single-user model; a future multi-user version should separate per-user stars and visit history. Add explicit star-setting and launch-recording API operations (not a non-idempotent toggle endpoint), with server timestamps and events for cross-device updates. Derive star state from a non-null `starredAt`; metadata edits and redeployments must preserve both `starredAt` and `lastOpenedAt`. Search spans both sections while retaining starred-first grouping.

Ports, generated unit names, and canonical managed origins are server-controlled. Store secret references separately, never secret values in registry/API responses. Runtime observations (service state, HTTP health, Tailscale reachability, last error) are distinct from desired state and include timestamps.

Two entry paths:

1. **Managed app**: Jelly allocates ports and manages its unit, gateway, and health.
2. **Linked app**: register an existing private app URL without taking ownership of its service. No stop/delete-service controls until explicitly adopted.

Use transactional port reservations, per-app deployment locks, idempotent registration, and conflict checks against actual listeners. A reserved database port is not proof the OS port is free.

Lifecycle: draft → deploying → ready, with separate stopped/unhealthy/failed observations. Failed deployment keeps diagnostics and any previously working release rather than leaving an apparently healthy tile.

**Remove from Apps** unregisters only. For a managed app, explain that it will continue running. A distinct **Uninstall service** action stops/disables and removes only Jelly-owned units/gateways; source code and app data remain unless explicitly deleted in a separate operation.

## Persistent services and networking

### Runtime

- Target this instance's Linux/systemd environment first; return an explicit unsupported-platform result elsewhere.
- Generate namespaced units such as `jelly-app-<id>.service` under the user's systemd directory.
- Use a production start command, absolute executable and working-directory paths, structured arguments, escaped unit fields, `Restart=on-failure`, and bounded restart rates.
- Build and test before activation. Keep runtime data outside replaceable build artifacts and retain the last known-good release. Code rollback does not reverse database migrations; migrations need a backup/compatibility plan.
- Enable units for boot; verify user lingering rather than assuming reboot persistence. Ordinary operations use `systemctl --user`, not root.
- Keep app lifecycle independent of `jelly.service`: deploying or stopping an app must not restart Jelly or other apps.
- Detect available service-manager/Tailscale capabilities up front and return actionable errors. Do not report deployment success until health checks pass.

### Private access

- Bind the application runtime only to its server-owned, instance/app-scoped Unix socket (`APP_SOCKET`); TCP-only managed apps fail closed, including loopback TCP. Gateway listeners remain loopback/Tailscale-only.
- A separately managed per-app gateway exposes an allocated origin locally and on explicit Tailscale addresses. Example: `http://box.tailbfab3f.ts.net:<app-port>`.
- Do not bind wildcard/LAN addresses. No Funnel, public DNS exposure, or automatic sharing with new tailnet members.
- Derive addresses from instance configuration/Tailscale discovery, never hard-code this machine's name.
- Local Jelly opens local app origins; remote Jelly opens tailnet origins. Never hand a phone a `127.0.0.1` app URL.
- Distinguish process health, HTTP health, and external reachability. A local HTTP success is not evidence that a phone can reach the app.
- Recover forwarding after Tailscale disconnect/reconnect and address changes. Local apps should remain usable while Tailscale is unavailable.
- Preserve streaming, WebSocket upgrades, upload/download behavior, and app redirects through the gateway.
- Tailnet ACLs still determine access. Tailscale reachability is not per-app user authentication; apps with sensitive data may need their own sign-in.
- HTTP on a tailnet hostname is not a browser secure context. Apps needing secure-context APIs require private HTTPS. Never embed an HTTP app into an HTTPS Jelly viewer; add a supported private TLS configuration or use direct launch with an explicit limitation.

### Isolation is a release gate

Do **not** reverse-proxy arbitrary app HTML under Jelly's own origin (for example `/apps/:id/content`). That would give app JavaScript Jelly's browser authority.

Different ports provide different browser origins, but **cookies are not port-scoped**. Reusing the machine hostname with different ports is therefore insufficient by itself:

- The app gateway must strip Jelly control cookies before forwarding to the runtime and reject reserved Jelly cookie names in app responses.
- Isolate/rewrite app cookies per app, including collision and deletion behavior; do not expose a raw runtime port through Tailscale that bypasses this gateway.
- Audit Jelly API reads and writes for cross-origin/same-site access, CSRF, credential bootstrap, redirects, and WebSockets. Never add app origins to Jelly's trusted control-origin list.
- Constrain gateways and health probes to registered destinations; no arbitrary URL-fetch endpoint, redirect-following SSRF, path traversal, or arbitrary unit management.
- Managed embedding is approved only for the tested restricted forced-HttpOnly + per-app-HMAC gateway. Chromium proves accepted cookie confidentiality/integrity and fail-closed duplicate/shadow/replay behavior; shared-cookie-jar exhaustion and injected Path/Domain shadows may still deny availability (accepted with warnings). JavaScript session-cookie apps are unsupported. Arbitrary cookie compatibility or stronger availability separation requires independent hosts and appropriate host-only cookies. Unverified modes must fail closed; direct launch never waives isolation, and raw same-host TCP fallback is prohibited.

App source runs under the same OS user in v1. These browser/network boundaries do not sandbox malicious server-side code. Strong process/filesystem isolation is a separate future capability.

## Make agents Apps-aware

Add concise instance-level instructions for every agent, not only a particular project's `AGENTS.md`:

> Jelly has an Apps Home Screen. When asked to build and publish a persistent web app, inspect the Apps capabilities, build it in its project, test it, and deploy/register it using the Apps tools. Use production user services and private loopback/Tailscale access. Include Jelly home navigation. Never claim an app is live until deployment and health checks succeed. Do not auto-publish every HTML preview or unfinished prototype.

Extend `instance_info` with the Apps Home URL and supported deployment/network capabilities. Provide structured tools backed by the same service layer as the UI:

- `apps_list` / `apps_get`: registry, ownership, status, URLs, and capabilities.
- `apps_register`: create/update metadata or link an existing private app; preserve stars and visit history on updates.
- `apps_set_starred`: set a specified star state when the user asks to star or unstar an app; never infer it from deployment.
- `apps_deploy`: validate manifest, allocate resources, activate a release, and verify health.
- `apps_control`: start/stop/restart a Jelly-owned app.
- `apps_logs`: bounded diagnostics with best-effort redaction; warn app authors never to log secrets.
- `apps_remove`: distinguish unregistering from uninstalling.

The deployment result returns app ID, viewer URL, local/tailnet URLs, unit name, checked health, and any pending remote verification. The agent's final response links to the app tile/viewer, not just a terminal port.

Ship an app template/deployment guide covering host/port configuration, health endpoint, storage, secret references, production command, home integration, framing headers, and direct-launch fallback. Reuse `ChatFormCard`/`ChatFormActions` if an in-chat setup or privileged handoff is needed.

## Implementation map

Current anchors:

- `src/client/App.tsx`: existing history-based project/chat navigation; introduce explicit top-level destinations without breaking that state.
- New `AppsHome`, `AppViewer`, app-detail components, and shared navigation state; extend `src/client/api.ts` and `src/shared/types.ts`.
- `src/server/store.ts`: migration and app records.
- New app registry/deployment/systemd/gateway modules; `src/server/app.ts` exposes validated APIs and existing event transport carries registry/status updates.
- `src/server/harness.ts`: instance instructions and tool registration; new Apps tool definitions remain thin wrappers.
- `scripts/tailscale.ts`: useful existing address-discovery pattern, but its raw TCP forwarding is **not** the cookie-isolating app gateway.
- `docs/DESIGN.md`: document Apps navigation and the viewer home control; add a deployment guide and generated-app template.

## Delivery sequence

1. **Compatibility/security spike**: prove isolated gateway cookies, iframe permissions, WebSockets, direct OAuth fallback, and mobile viewer behavior with disposable fixture apps. Resolve hostname/HTTPS requirements before committing to networking.
2. **Registry and Home**: migration, metadata APIs, linked apps, starred icon grid, chronological unstarred history, persistent star/launch APIs, Apps/Agents navigation, details, deep links, and unavailable states.
3. **Managed deployment**: port allocation, generated user units, gateway, health observation, lifecycle operations, partial-failure cleanup, and last-good-release rollback.
4. **Agent integration**: capabilities, tools, instructions, template, Build an app/Edit with agent flows, and useful chat results.
5. **Hardening and activation**: automated checks plus real local/Tailscale and reboot validation. Document limitations before rollout.

## Acceptance checks

- Ask an agent to build an app; it appears on Apps only after explicit registration/deployment, opens on desktop and phone, and has a working home control.
- Home navigation survives app crashes, loading failures, internal navigation, reloads, direct bookmarks, and unavailable Tailscale.
- Apps/Agents navigation does not lose drafts, project scope, scroll position, or active conversations.
- New apps enter History unstarred. Starred apps appear only in the top icon grid, ordered by `starredAt` descending; opening or renaming them never changes that order. Unstarred apps appear only in History, ordered by `COALESCE(lastOpenedAt, createdAt)` descending; opening a historical app immediately moves it to the top.
- Star/unstar works with touch and keyboard, preserves focus, survives reload/restart, syncs across devices, and rolls back visibly on save failure. Redeployment and metadata changes never reset stars or visit times.
- Launches update History once per navigation; health checks and internal app navigation do not reorder it. Unstarring restores chronological placement without inventing a visit. Empty-section states and history pagination work.
- Unstarring or leaving a one-off app unused does not stop its service or delete its data.
- App services survive agent completion, Jelly restart, and host reboot; starting/stopping one does not affect another.
- Concurrent deployments cannot claim the same ports or overwrite another app's unit. Failed deployment retains the last healthy version where feasible.
- Unregistering, uninstalling, and deleting data have different, tested effects.
- Tests prove an app cannot read Jelly APIs/control credentials, set Jelly cookies, navigate the top-level viewer, or escape the gateway's registered destination.
- Unit/API tests use temporary databases and a fake service-manager/network adapter. Real-service smoke tests use uniquely named disposable units, never the live database.
- Browser tests cover keyboard focus, three-column phone layout, safe areas, no home-control overlap, Back/Forward, frame denial, direct fallback, and WebSockets.
- Run `bun run check` before deployment. Schedule Jelly activation through the existing idle-restart helper, never restart inline; verify both loopback and Tailscale after restart.

## Deferred

Public publishing, marketplace/discovery, arbitrary remote hosting, multi-user app permissions, container isolation, native packaging, custom domains, and a visual app editor. Apps v1 is a private launcher plus reliable deployment for this Jelly instance.

## Implementation evidence and release limits

The implementation is integrated, not a prototype. SQLite v13/v14/v15 migrations, a single Store-backed Apps service, transactional registration/defaults/port reservations, leased per-app deployment locks, retained releases/data, systemd runtime/Node gateways, private APIs, agent tools/instructions, launcher/viewer, raster icons and the runnable template are delivered. No automatic publishing, starring, expiry or data deletion was added.

Automated evidence (temporary databases/fake managers unless the explicit disposable-host smoke is named):

| Gate                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full integration                 | `bun run check` in a clean test environment (worker-only Pi identity/session variables unset): **508 tests, 5654 assertions, 0 failures**; typecheck, server/browser transport/client/capability/Apps suites, production client and Chrome builds pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Registry/lifecycle/tools         | `tests/apps.test.ts`, `tests/apps-tools.test.ts`, `tests/apps-api.test.ts`: stars/history/idempotency/cursors/reopen/no cascades, partial metadata/default ownership, concurrent locks/ports/listeners, immutable-instance unit ownership across shared adapters, unsafe start/restart/observer quarantine distinct from HTTP-health failure, stable short owner-checked Unix sockets, mode-policy preservation and nullable linked-origin clearing, required test/build isolation, last-good rollback/repair, bounded diagnostics, remove vs uninstall/retention and observer shutdown.                                                                                                                                                                                                                                                                                                                                                 |
| Cookie/control isolation         | `tests/apps-gateway.test.ts`, `tests/apps-api.test.ts`, `tests/control-session.test.ts`: actual Chromium raw-runtime TCP bypass rejection plus HttpOnly confidentiality/integrity, exact-tuple JS overwrite resistance, duplicate parent-Domain/narrower-Path rejection and recovery, cross-app HMAC replay/deletion, redirect/error/WS cookies, private-read/all-legacy-mutation CSRF matrix, bootstrap/opaque-origin/CORS denial and Jelly anti-framing. Actual disposable HTTPS browser proves `__Host` policy and legacy retirement; this is not built-in production TLS.                                                                                                                                                                                                                                                                                                                                                            |
| Direct OAuth/transport           | Real Chromium direct OAuth GET callback retains app-bound HttpOnly/Lax state through a disposable TLS identity-provider fixture; cross-origin `form_post` is rejected. Real Node WS text/binary/subprotocol/multiple cookies and streaming/upload/download/redirect restrictions pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Apps navigation/browser          | `bun tests/apps-viewer.browser.ts`: 1280/390/320px Chromium layout, keyboard/star focus, safe areas/corners, deterministic home, Back/Forward, reload/internal-route launch dedup, validated bridge, sandbox escape denial, frame-denial/direct/no-opener fallback and private handback. `tests/apps-client.test.tsx` checks mounted Agents/project/draft/scroll/unread preservation, Build/Edit unsent intent and explicit capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Existing browser regressions     | `bun tests/mobile-layout.browser.ts`: 14 idle/running cases at 320–1280px; `bun tests/history-scroll.browser.ts`: desktop/mobile 0px drift across delayed auth/images/error/retry/growth; `bun tests/agent-identity.browser.ts`: desktop/390/320 name/avatar editing and direct header form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Real disposable services/network | `bun scripts/apps-smoke.ts`: copied template outside temporary instance release data, five UUID-owned app IDs, real Node 22.22.1/systemd, verified lingering and enabled boot units. Local and `box.tailbfab3f.ts.net` gateway HTTP 200 from this host, no raw runtime TCP origin, exact Bun/Node Unix socket health, cgroup-descendant arbitrary-port TCP quarantine with both owned services stopped and ordinary outbound HTTP retained, unchanged app/gateway PIDs across temporary Jelly close/reopen, stop/start/restart and sibling independence, unregister continues running, uninstall retains source/data, failed activation leaves no unit/boot-link remnants. Paths with spaces/percent/dollar and forced metadata overriding forged environment-file fields are exercised. The complete generated DNS/bare-hostname/IPv4/IPv6 origin set is exercised. Only owned units/links/socket directories/temp storage are cleaned. |

Real smoke exposed and repaired systemd WorkingDirectory/EnvironmentFile field escaping, disable/stop-before-removal rollback ordering, and intentional launcher termination incorrectly reported as service failure; regression tests cover these. Legacy legitimate fixtures were updated for sessions/CSRF and genuine old migration schemas, without weakening missing-auth tests or introducing production bypasses.

**Limits:** actual host reboot, a separate tailnet peer/phone, real Safari/WebKit/PWA, production private TLS and arbitrary web-app cookie compatibility are not verified here. Production `jelly.service` restart and same-host loopback/Tailscale HTTP were verified by the initial idle activation. HTTP is not a secure context; HTTPS Jelly never embeds HTTP apps. Shared-host cookie-jar exhaustion and injected Path/Domain shadows can deny availability, even though accepted credentials remain confidential/integrity-protected. JavaScript session-cookie applications and stronger availability separation require independent hosts with host-only cookies. Direct mode never waives isolation. Same-OS-user server source is trusted, not process/filesystem sandboxed; diagnostics redaction is best effort, data migrations still require tested backups, and retained release/icon/data storage has no automatic cleanup policy.

Implementation and tests used disposable registries, with no direct agent writes to the live registry, existing app source/data modification, staging/commit, inline Jelly restart, reboot, public exposure or source-lane relaunch. Production activation occurred separately through the idle-restart helper, which verified active/enabled service and loopback/Tailscale HTTP. Follow-up patches require the same idle procedure. The unrelated `docs/COMPUTER-USE-MACOS-RESEARCH.md` is preserved.

Review corrections replace raw-loopback upstreams with mandatory canonical owner-only Unix sockets, namespace both unit names and markers by immutable instance identity, and quarantine unsafe owned cgroup descendants. The real user-manager probe confirms bind-denial BPF is not enforced on this host; periodic cgroup checks are defense-in-depth, not an OS sandbox. Ordinary exited-process `/proc` races are distinguished from live unreadable inventory. Gateway health requires gateway-stamped exact instance/app/revision identity, after stripping upstream `x-jelly-*`; fake and real same-port collision tests reject foreign healthy gateways without affecting the original instance. The versioned idle-restart helper now probes public `/api/health` without weakening private API authentication, discovers validated private Tailscale DNS/IP rather than hard-coding this machine, and accepts a validated nonsecret `JELLY_RESTART_PORT` (default 5173). Its portable tests copy/source only discovery functions; no actual Jelly restart occurs. Unregister irreversibility (loss of Apps controls/same-ID re-registration/later Apps uninstall) is explicit in UI, tools and docs. Initial production activation is verified; real phone/Safari/reboot, independent remote-peer access and private TLS remain unverified.

The final observer/lifecycle race correction acquires the same renewable per-app lease before asynchronous isolation checks, quarantine and publication, re-reading the current record inside it. Busy apps are deferred rather than stopped from stale observations; same-revision restarts are protected as well as redeployments, and concurrent stars/visits are preserved. Three deterministic regressions include separate service objects sharing the registry. Parent-owned `bun run check` passes 505 tests/5634 assertions and `bun run test:apps-smoke` passes again with owned cleanup complete. Final independent re-review approved the observer lease correction with merge verdict OK. Initial activation passed the idle restart and HTTP verification; subsequent fixes are activated and checked through that same helper.

The Astra code/UI review's follow-up fixes apply exclusions and containment to resolved snapshot targets, inspect directory aliases with cycle protection, preserve safe internal aliases, and cover excluded-directory aliases with nested external links. Removal dialogs now keep the native checkbox and explanation visible; Apps/Agents navigation has balanced padding and reserves the top safe area only once, Apps search is rounded, and phone diagnostic labels stack without splitting mid-word. Real Chromium regressions cover removal geometry and navigation in light/dark at 320/390/1280px. Full checks and existing mobile/history/identity browser regressions pass; the latest full check has 508 tests/5654 assertions and zero failures.
