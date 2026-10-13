# Native Mac desktop tools (Peekaboo)

Jelly's existing web UI can configure a separately installed Peekaboo CLI and
signed Peekaboo.app. Use the **official unmodified 4.9.0 releases**; no vendor
rebuild, re-signing or redistribution is required. Desktop access starts off and
requires exact operator application grants. It is not a
native Jelly app, browser target, driver installer, or second autonomous agent.

## Local setup

The Jelly backend must run on the Mac being controlled, in a logged-in GUI
session on macOS 15+. Opening a Linux-hosted Jelly page on a Mac does not connect
that Mac's desktop. Remote desktop transport is not implemented.

In **Settings → Tools → Native Mac desktop** explicitly select:

- The absolute path of the standalone signed `peekaboo` CLI (not the executable
  inside Peekaboo.app).
- The absolute path of the signed Peekaboo.app permission host.
- Its exact Bridge socket, ordinarily
  `/Users/you/Library/Application Support/Peekaboo/bridge.sock`.
- Allowed native application bundle IDs; begin with synthetic Calculator and
  disposable TextEdit fixtures.
- Screenshot retention/model-delivery consent, separately from desktop access.

Grant Accessibility, Screen Recording and Event Synthesizing to the selected
**Peekaboo host** through macOS's permission UI as needed. Never grant them to
Bun/Node just to work around a failed host connection. Jelly neither opens an
alternative host nor launches a daemon, installs/updates/quits the user-owned
host, modifies user-wide MCP configuration, or requests vendor model credentials.
Use **Connect selected host** for an explicit connection attempt. A missing,
unsupported, mismatched, or unverifiable host must produce a refusal rather than
local fallback.

The supported adapter is version-bound to 4.9.0. It checks official signing,
explicit GUI routing, available schemas/host operations and actual permissions,
then enables supported scoped operations. There is no separate certification or
rollout flag.
The Mac used for initial implementation has **3.0.0-beta3** installed; this
legacy CLI is not the candidate contract and must not be used for live input.

## Ownership and tool boundaries

`desktop_status` is passive. The separate `desktop_apps`, `desktop_windows`,
`desktop_observe`, `desktop_click`, `desktop_type`, `desktop_key`,
`desktop_scroll`, `desktop_menu`, and `request_desktop_handoff` tools expose only
restricted desktop actions, not the upstream MCP catalog. Unsupported actions
refuse explicitly. Browser tools and the existing browser target selection remain
separate. Detached children do not receive desktop authority.

One run retains desktop ownership through observe → decide → act → verify and
until the complete run and its children settle. Foreign runs receive a bounded
busy/refusal result. References are opaque, run-bound, and invalidated by input,
compaction, disconnect, host replacement and handoff. Re-observe after every
mutation, including failed/partial or unverifiable mutations. An error or dropped
response does not prove no input happened. Never automatically replay it.

Background accessibility actions are preferred. Foreground access requires an
explicit expiring grant for the exact live run through Settings, and remains
unavailable because this adapter does not implement that grant lifecycle. No
targetless keys, clipboard access, raw provider methods, socket/executable
arguments, model-selected paths or global coordinates are exposed. Background
image-pixel clicks require the current exact-window screenshot reference. Browser, shell/terminal, password-manager,
Keychain/security-settings and Jelly/Peekaboo control surfaces are excluded.
Allowing an app is not task authorization for every send/delete/payment in it.

Cross-instance ownership controls constrain **cooperating Jelly paths**. They do
not constrain third-party MCP clients or unrestricted same-user shell access.
Unknown owner liveness/host completion blocks new automation; PID age or a stale
filename is not proof of safe reclamation.

## Private handoff and recovery

Use **Pause desktop**, **Stop desktop automation**, or `request_desktop_handoff`
when a person needs the Mac. Stop revokes Jelly automation without quitting any
app. Admission closes before waiting; pending captures/results are suppressed.
Do not enter credentials while status says **Pausing**, **Unsafe**, unavailable,
or failed. Cancellation, timeout, expiry, shutdown, and loss of an MCP proxy are
not host completion acknowledgements.

The private handoff card becomes usable only after accepted desktop work is
known to have drained and participating browser sessions acknowledge pause. Use
the Mac directly, then select **Return desktop control**. Browser sessions paused
for this handoff are not implicitly resumed: explicitly resume those sessions,
then resume desktop in Settings for a current run. A private browser handoff also
pauses desktop first; browser handback never implicitly resumes desktop. The
Chrome extension's local pause acknowledgement covers Chrome, not native desktop
drain; wait for Jelly's confirmed shared private reservation before entering
credentials when desktop control is participating.

Cancelled/expired handoffs retain the automation pause and shared exclusion.
**End private desktop work · keep automation paused** in Settings is an explicit
standalone handback, including recovery from a settled card. It removes only the
native-work reservation; another private browser reservation continues blocking
other instances. Ending private work never enables input.

If completion cannot be established, remain blocked and recover that exact host
through its supported mechanism. Do not delete lease/quarantine files, signal a
PID copied from earlier status, switch sockets, or assume that killing the proxy
made credential entry safe. Relaunching a host needs fresh identity qualification
and observations, not replay of the uncertain action.

## Screenshots, privacy and deletion

Only explicitly consented exact-window captures are eligible. A preceding AX
read rejects known secure fields before requesting pixels; the image response
must also match the exact process generation/window receipt. AX coverage and
privacy completeness may be unknown, and that is reported honestly rather than
inventing a globally non-sensitive/standard surface. Raw AX values, titles,
labels, provider diagnostics and arbitrary metadata/paths are not model output.
Images are **not guaranteed secret-free**; grant capture consent deliberately.
The model receives only bounded raster data with ancillary PNG metadata stripped.

Validated raster blocks use Jelly's existing image pipeline. They can become
visible, durable chat attachments and be sent to the selected model provider.
There is no special desktop retention period or per-capture deletion API.
Disabling desktop tools, stopping a run, archiving an agent, closing the MCP
client or deleting a temporary fixture **does not delete history**. Existing
instance messages, checkpoints and timeline data remain in the instance database
and its backups. To erase all local instance history, stop Jelly and remove its
instance data/backups using the existing full-instance data-management procedure;
do not edit a live database. This does not retract data already sent to a model
provider or downloaded attachments. Consult that provider's retention/deletion
controls separately. Jelly never deletes the user's Peekaboo caches.

## Released operations and authority

The adapter uses source tag `v4.9.0`, commit
`7020aedd362038043e4fc1988a8634657270e476`, without patching the vendor:

- Official `app list --json` supplies canonical bundle IDs, PIDs and lossless
  `process_start_identity_decimal`; `window list --json` supplies candidate
  window IDs/bounds and owner bundle/PID. These are **discovery only**. App
  generations are checked again around observation. No inventory prose is parsed.
- One retained `mcp --bridge-socket <canonical GUI socket>` client issues actual
  `inspect_ui`, `see`, `click`, `type`, `press` and `scroll` calls. The immutable
  native session is background-only, with no foreground/temporary-clipboard grant.
- Released `_meta.target_receipt`, `snapshot_id`, `ui_elements` and `used_cache`
  bind each observation to the expected allowed owner/window. Fresh producer-bound
  `ps1_` references remain inside the provider; the signed native CLI/host enforce
  producer ownership, process generation, window geometry and receiver validation
  at dispatch. Jelly does not fabricate hidden geometry/privacy receipts.
- The displayed host generation is a **Jelly MCP-client epoch**, not a host PID.
  Independent pre/post `bridge status` calls detect selected-host/capability
  changes but are **not persistent-connection attestation**. Native Bridge client
  peer authentication/session pinning remains the connection authority. No local,
  alternate-host or stale-snapshot fallback is allowed.
- `desktop_click` supports current elements or in-image coordinates from a current
  screenshot. `desktop_type` sends bounded literal non-secret text without clearing
  existing content. `desktop_key` retains the limited non-clipboard chord set.
  `desktop_scroll` takes an **elementRef**, direction and 1–50 ticks, using the
  released request-pinned exact-window scroll contract. Actual unavailable schemas,
  Bridge operations or OS permissions remain factual refusals.
- Menu mutation is not wired: the released MCP menu schema takes app/PID/path but
  cannot consume Jelly's caller-generation/snapshot reference before dispatch.
  Foreground/shared-pointer input has no expiring per-run grant implementation.
  Neither is bypassed using raw selectors or global input.

Healthy completed native `delivery_accepted`/`suspected_noop` results are distinct
from unknown host completion. Their semantic effect may be unverified: invalidate
all references and **observe afresh**, never blindly replay. Confirmed no-change
and refusal are also terminal. Partial cleanup failures, `operation_still_running`,
cancellation, timeout and lost/malformed responses retain unsafe quarantine and
block private credentials. Subsequent status/permission queries, observation or
proxy death do not prove drain. No new drain RPC is required for healthy use.

The old proposal to fork Peekaboo for extra public metadata is superseded. An
isolated temporary research copy was edited but not shipped, installed or launched;
its incomplete Swift build is not release/test evidence. Only official signed
artifacts are used. The previously verified app/arm64 CLI pair has Developer ID
team `FWJYW4S8P8`, identifiers `boo.peekaboo.mac` and `boo.peekaboo.peekaboo`.
No worker changed live settings, OS grants, user-wide MCP or installed hosts.

See [the parent/operator live fixture](PEEKABOO-LIVE-FIXTURE.md) for installation,
exact grants and scoped Calculator/disposable TextEdit testing. Live testing is
useful validation, **not a hardcoded production enablement gate**.

## Tests and qualification

`bun run test:peekaboo` exercises fake MCP/provider responses and temporary
instances: authorization/CSRF/origin checks, ownership and stale references,
partial/unknown outcomes, cancellation and private UI gating. It does not grant
OS permissions or read personal apps. The test-only Bun preload selects React's
development build and isolates inherited Pi runner identity/configuration. Test
scripts use a bounded 30-second default for process/GUI fixture startup (the
multi-context TLS/WebRTC fixture has a 90-second overall budget; the integration
that launches multiple Pi child runtimes has 120 seconds). Startup waits confirm
real request/running-state acknowledgements before testing cancellation/liveness.
Production settings are unaffected; protocol safety deadlines and assertions are
unchanged.

`bun run check` needs an installed Chromium for the headless browser safety
fixtures. Test discovery prefers Playwright's installed Chromium, then standard
Chrome/Chromium paths (including macOS apps); an explicit `JELLY_BROWSER_PATH`
never falls back if invalid. If absent, install with
`bunx playwright-core install chromium` or select an absolute executable path.
Tests never download it automatically and always use temporary profiles. The
SOCKS/TLS/WebSocket/WebRTC safety fixture now runs on Mac rather than silently
skipping for a missing Linux Chrome path. The separate managed-X11 fixtures still
require their existing Linux Xvfb/x11vnc runtime; this is not a Mac browser-port
redesign. On unsupported platforms, native-daemon tests assert the real platform
refusal with zero spawned processes/protected ports, not Linux collision success.
The socket shutdown fixture accepts only an optional `ECONNRESET` before confirmed
closure. The preload selects a short canonical Mac temporary root automatically
so nested Unix sockets fit the platform limit, without weakening apply-patch's
ancestor-symlink refusal. Apps API fixtures forward an existing programmatic
`appsOptions` seam to select their own socket base; production defaults stay
unchanged. Socket validation retains canonical owner-only parent/marker checks
and non-following `lstat` type/owner checks, avoiding Bun/macOS's unsupported
`realpath(socket)` call; real-socket and socket-symlink regressions cover it.

`bun run test:peekaboo:mac -- --inspect-installed --cli /opt/homebrew/bin/peekaboo`
is an explicit opt-in **read-only installation diagnostic**, not a successful
qualification fixture or activation command. It checks the chosen signed CLI's
version and the selected app/socket's presence; it never starts MCP, launches a
host, requests permissions, captures or enters input. `--host-app` and `--socket`
accept explicit absolute selections. A refused legacy CLI exits nonzero and is
negative-path evidence, not a Calculator/TextEdit success claim. The ordinary
test suite never connects to live desktop settings or the live Jelly database.

The earlier Mac reliability pass completed `bun run check` with 606 tests and
three existing Linux/X11 skips. The release-only adapter adds source-named JSON
fixtures and actual SDK fake-wire tests in `tests/peekaboo-release.test.ts` for
scoped actions, stale/missing receipts, unknown privacy, image coordinates, host
replacement, loss and no replay. These tests never perform native automation.
See the implementation report for the latest full-check totals. Real OS grants,
Calculator/TextEdit interactions, Retina and host-restart behavior remain untested
by this detached worker; the operator/parent uses only scoped `desktop_*` tools.

Version-matched upstream references: [MCP](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/MCP.md),
[Bridge host](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/bridge-host.md),
[automation](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/automation.md),
[permissions](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/permissions.md).
