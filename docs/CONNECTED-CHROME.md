# Connected Chrome — shared-profile local implementation

**Connected Chrome** is a separate browser target, not a managed controller.
Choose one explicitly connected profile and site scope **globally for every
persistent Jelly agent**. Agents use separate task groups and exclusive tab
capabilities but share that profile's cookies and signed-in accounts. Managed
Playwright/AgentBrowser profiles, SOCKS egress and VNC remain available and
unchanged. Existing sessions remain pinned until explicitly closed.

The local implementation has real headed-Chrome coverage, including two agents,
two profiles/instances, frames and handoffs. It is still experimental: **this is
not a claim that every signed-in-profile security/hardening requirement is
complete**. See remaining rollout gates below. Installing into the user's normal
profile and activating the global setting are separate, explicit operator steps
after review; tests never modify the normal profile or live Jelly settings.

## Setup (Linux, same OS user and machine)

1. Start the intended Jelly instance. It creates private
   `<dataDir>/chrome-bridge/` (0700), `pairing.json` and `bridge.sock` (0600).
   Never display or copy `pairing.json`: it contains the instance grant.
2. Run `bun run build:chrome`. In the **chosen Chrome profile**, open
   `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
   select the absolute `dist/chrome-extension` directory.

   Jelly's own fixed public manifest key gives the reproducible development ID
   **`mikadpfmkipiafkemjplldmfckomphcf`**, independent of the checkout/build path.
   The key was generated for Jelly; it is not OpenAI's identity. No private
   signing key is committed or retained and this is not a Web Store signature.
3. Install Jelly's separate native host, explicitly selecting the instance and
   Chrome **user-data root** (the directory containing `Default`, not `Default`):

   ```sh
   bun run chrome:install-host --data-dir /absolute/jelly/data \
     --chrome-config /absolute/chrome-user-data
   ```

   For the normal Linux installation the latter is ordinarily
   `~/.config/google-chrome`. For tests always use a temporary path. The fixed
   development extension ID is the installer's default; `--extension-id ID` is
   available for a separately reviewed build. Installation creates only
   `NativeMessagingHosts/org.jelly.browser.json` and this instance's private
   wrapper/config/ID registration. It refuses another instance's existing Jelly
   manifest and preserves unrelated hosts. Moving Bun/repository requires
   reinstalling the wrapper. One host registration chooses one Jelly instance
   per Chrome user-data root; use separate roots for separate instances.
4. Open the Jelly extension popup and click **Connect to installed Jelly
   instance**. Compare its instance ID and persistent profile UUID with Jelly.
5. In **Settings → Browser target**, choose Connected Chrome, the exact connected
   profile, and exact HTTPS origins (one per line), then **Save browser target
   and site scope**. This is a global setting, not per-agent setup. Every
   persistent agent's next unpinned browser session uses it.

   Scope is explicit: no wildcards, HTTP, literal IPs, local aliases, Tailscale
   hosts, internal schemes or Jelly/control origins. Approve required asset and
   identity-provider origins deliberately, not with blanket permissions. A
   disconnected selected profile never falls back to another profile or managed
   browser. Already allocated sessions keep their target/profile/sites; stop the
   agent and **Close / Reset pinned target** to change those choices.

No Chrome restart, remote-debugging port, profile copy or cookie migration is
needed. Browser-on-laptop/Jelly-on-server needs a separate authenticated remote
transport; local native messaging cannot bridge machines.

## Tasks, tools and user tabs

- `browser_name_task` gives groups a short task label:
  `🔎 Jelly · Agent · Task`. Agent colors are stable; groups are per task/window.
  New task tabs are background tabs. Only explicit **Open in Chrome** focuses a
  tab/window; Jelly enables it only after acknowledged pause. Human regrouping/
  group deletion never grants or transfers a lease.
- `browser_open`, `browser_tabs`, `browser_snapshot`, `browser_screenshot`, exact
  `browser_click`/`browser_fill`, bounded `browser_scroll`, `browser_select`,
  referenced `browser_key` and `browser_wait_for` are supported. Keys are semantic
  button activation or element-scoped key events, not OS/global shortcuts or
  trusted general keyboard emulation. Select takes an option value; snapshots
  do not expose selected form values. Waits support bounded visible text,
  untruncated text absence, or DOM readiness, never arbitrary evaluation.
- Snapshots combine bounded visible text and exact references from authorized
  same-process and cross-site/OOPIF documents. References bind to connection,
  session, tab, document and observation epochs. Frame origins must be granted;
  hidden/clipped frames, srcdoc, object/embed and author shadow roots (open or
  closed) fail closed. The isolated extension uses Chrome's
  `chrome.dom.openOrClosedShadowRoot` on a bounded light-DOM scan; it rejects
  the entire document rather than inspecting private root contents. Missing API
  support also fails closed. A secret field anywhere makes the whole tab unobservable. Actions
  cannot use another document's/agent's stale reference.
- Screenshots return PNG tool image content, never base64 text in model output.
  Screenshots with detected secret/nonempty/contenteditable fields or any author
  shadow root are rejected. Stable closed-root fields cannot bypass these guards;
  transient rendering/capture races remain a separate, unresolved rollout gate.
  Large images fail at the bounded cap rather than exporting to disk.
- To grant an existing user tab, first let an agent start its browser task.
  In the **extension popup**, explicitly choose the task and an approved-site
  user tab, then **Grant selected tab**. Only the packaged popup can do this;
  models cannot enumerate or claim unrelated user tabs. Numeric tab IDs never
  reach model tools. The chosen tab keeps its original group. Closing it through
  `browser_tabs` means **release**, not browser closure. Settlement always releases
  user tabs without closing them. A second task cannot claim an existing lease.
- Popups are adopted only from an exclusively leased opener during an authorized
  run, after installing policy and checking the destination. Adopted popups get
  fresh capabilities and task groups; unapproved/failed popup adoption pauses the
  task and does not disclose its content. **Chrome can start popup networking
  before its creation notification**; see the rollout gate below.

## Pause, private handoffs, settlement and recovery

`request_browser_login` opens a scoped task tab, marks it for retained handoff,
pauses and detaches before waiting. During reservation/open/mark/drain the inline
`ChatFormCard` says **Pausing—do not enter credentials yet**. **Open in Chrome**
and **Return control to agent** stay disabled until live task state confirms the
matching handoff's reservation and extension pause acknowledgement. Failure and
disconnection never advertise private-safe state. This is the real browser,
never VNC.
Enter credentials only in Chrome after the pause acknowledgement. Approved site
restrictions remain during handoff. Resume invalidates observations; secret-field
pages remain blocked until the fields disappear.

The extension popup always offers **Pause all agents locally** and **Disconnect**.
Local pause revokes authority before notifying Jelly, drains already-dispatched
isolated scripts/captures/tab mutations and waits for debugger attachment/detachment. An action
already admitted before pause may complete before acknowledgement; its result is
revoked and it is never replayed. **Wait for paused status before entering
credentials.** Server authority revocation is separate from acknowledged pause;
settings and the extension popup show **Pausing—do not enter credentials yet**
while draining, not **Paused**. Jelly's settings also expose per-task
pause/resume/focus/disconnect.
Debugger attachment is cleared only after confirmed detach or tab removal;
rejected detach reports **Pause failed**, never acknowledged **Paused**. Retry
pause explicitly or close the affected tab; do not enter credentials after a
failed or uncertain transition. Resume removes the human-safe indicator before
dispatch and displays **Resuming—do not enter credentials** until acknowledgement.
Late responses cannot undo a newer pause, and failed resume never restores a safe
indicator. Settings, cards and the packaged popup discard superseded status reads.
Native pause/end preempt queued work; cancellation/timeouts disconnect, making
in-flight mutation outcomes indeterminate. Debugger conflict/cancellation pauses,
with no automatic reattachment until explicit resume.

After the complete Jelly run settles and children are disposed:

- Temporary agent tabs close.
- Deliverables (`browser_keep_tab`, default `mark: "deliverable"`) remain open
  without a lease/debugger and with task restrictions removed.
- Agent tabs marked `handoff` remain reserved and paused across follow-up runs.
  Explicit local/user pause also preserves temporary agent tabs if the run settles
  before resume, so settlement cannot close a tab during private human work.
  Resuming restores those implicitly preserved tabs' normal temporary cleanup.
  The same task/profile persists but the next run gets new run authority. Start
  a follow-up browser run, then explicitly **Resume**; old-run tools are rejected.
  A follow-up that never uses the browser does not discard a retained handoff.
- User tabs always remain open and are released, even during automatic cleanup.
- Closing an idle retained session releases retained tabs as well; it does not
  silently retarget another active session.
- Human closure of the last idle retained tab removes the extension session, so
  repeated Close/Reset cycles do not exhaust its task capacity.

Disconnect, worker termination, browser/server restart and tab replacement revoke
capabilities; there is no mutation replay or automatic authority reconstruction
from numeric IDs. Reconnect explicitly, close/reset the lost Jelly session and
allocate anew. Startup reconciles only cleanup: detach this extension's old
sessions and remove its stale per-tab rules; never close/reclaim leftover tabs.
They can be explicitly selected again through the user grant UI. Navigation,
frame-document changes, detach and handoff invalidate references; group deletion
only discards organizational metadata. Cleanup cannot guarantee closing temporary
tabs after transport has vanished.

Debugger cleanup obligations are separate from tab leases and are persisted in
extension session storage **before** an attachment attempt. Disconnect revokes
all authority but does not forget a rejected or uncertain detach. Reconnect
refuses pairing until cleanup is confirmed, and quarantined tabs cannot be
re-granted. Worker recreation reloads these cleanup-only IDs; it never reconstructs
a lease. If the popup reports unresolved debugger cleanup, retry Connect after
closing DevTools/cancelling the debugger, or close the affected task tab. A generic
detach rejection is not treated as success; another attached debugger may cause
conservative refusal. Legacy installations lacking this metadata quarantine their
old per-tab rule targets until cleanup rather than assuming they are safe.

## Security boundary and remaining rollout gates

Protocol v3 has schema-validated methods/identities, pairing grant, extension ID,
instance/profile/connection generation binding, bounded pending requests and event
rates. Pause progress/failure/acknowledgement events also bind to the current run.
Older protocol versions are rejected: reload the unpacked extension when idle
after updating Jelly, then reconnect explicitly; no old capability is restored.
Native frames use a 32-bit little-endian length (supported Linux machines
are LE) with a **768 KiB** ceiling, below Chrome's 1 MiB limit; PNG base64 is capped
at **650,000 characters**. Slow readers time out; no mutation is retried. There is
no artifact chunking. Native stdout is frames only; diagnostics omit grants/page
content. Owner-only sockets/configuration are an OS-user boundary, not a sandbox
against unrestricted same-user shell/filesystem access.

Permissions: nativeMessaging, debugger, tabs, tabGroups, storage, scripting,
webNavigation, declarativeNetRequest, HTTPS hosts. Packaged isolated-world scripts
and document/lease/site checks implement observations/input, including OOPIFs;
CDP is internal for debugger lifecycle/screenshots. There are no page/content-
script control RPCs, arbitrary eval/CDP tools, cookie/password/autofill/browser-
storage reads, history/bookmarks tools or network response bodies.

Agent tab DNR restrictions are installed before first navigation and block
unapproved main documents, redirects and subresources. This is **not managed
SOCKS egress isolation**. Outstanding signed-in rollout risks include:

- Pre-notification popup traffic and service-worker/background requests without
  tab association; DNS rebinding/public aliases and sensitive control endpoints.
- Transient render/secret-field races during screenshots, unusual embedded
  documents and every debugger attach/takeover interleaving. Stable author shadow
  roots now fail closed, including closed roots; this does not prove atomic capture.
  Pre/post guards and drain barriers reduce risk but are not a proof against
  hostile pages rendering secrets between samples.
- Live tab replacement/prerender activation and full browser/server restart
  matrix (the headed suite exercises actual worker-target termination/reconnect
  and native bridge listener restart, not every application/update/restart mode). Automatic Chrome suspension with a native port
  is browser-version dependent.
- Child browser identities: **unavailable**, not parent tools. Full Pi SDK and
  extension docs and pi-subagents child launch boundary were inspected. Detached
  children load allowlisted providers in another process; parent's customTools
  are not a safe provisioning channel. A reviewed authenticated per-child IPC
  adapter with lifecycle revocation is still needed. All **persistent Jelly
  agents** share the global choice; this does not silently grant subagents access.

Separate deferred work: reviewed upload/download artifact protocol and chunking,
remote authenticated transport, side-panel chat/cursor overlays, automatic
updates, cross-platform installation and public Web Store distribution/signing.
No normal-profile cookie/login settings are changed. No claim is made that this
extension prevents every site-initiated download.

## Validation

`bun run check` runs TypeScript, managed/server/client regressions and builds.
`bun run test:chrome` runs protocol/native/API tests and real **headed Chrome for
Testing** via extension → native host → private socket. It uses only temporary
profiles, temporary host installs and local fixture sites. Playwright's private
pipe provides fixture/human inspection and worker termination, not Jelly browser
actions. `JELLY_EXTENSION_BROWSER_PATH` can select a compatible executable;
Xvfb or DISPLAY is required. Only fixture builds allow loopback HTTP.

The live suite covers simultaneous agents and profiles/instances, foreign tab
and reference rejection, user grants/release preserving groups, group deletion,
exact fill/click/select/key, bounded waits, native PNG, same-process and verified
OOPIF actions, secret fields in child frames, popup adoption, retained handoff
across runs, stale run rejection, zero-hit denied redirect destination, human
closure, local pause racing real queued renderer observations/screenshots/fill/
click, native version mismatch, worker termination/reconnect, native bridge
restart, stale generations, cleanup and disconnect. Closed-root secret, nonempty
and contenteditable fields are real-extension rejection regressions, including
closed secret/nonempty fields in an independently verified OOPIF. A drain test
holds delivery of real capture/fill API responses in the disposable worker with
an already-attached extension debugger: pause cannot acknowledge until released,
revoked results are suppressed, and the extension can no longer issue debugger
commands after acknowledgement. That deterministic response-delivery hold is not
a claim that admitted mutations had no side effects or that capture is atomic.
Unit/client tests additionally cover delayed open/mark/pause acknowledgement,
private-control gating, distinct failed/disconnected states, global persistence/pinning,
retained handoff routing, unsupported child identity, framing/slow peers,
installer preservation, tool-image content and handoff/settings UI. See the plan
matrix for what remains unverified; no synthetic event is presented as a real
browser replacement or signed-in-profile test.

## Uninstall and activation

Stop agent runs, disconnect locally, then use the same explicit instance/root:

```sh
bun run chrome:install-host --data-dir /absolute/jelly/data \
  --chrome-config /absolute/chrome-user-data --uninstall
```

Remove Jelly's unpacked extension in Chrome. Only this instance's native
manifest/wrapper/config/ID registration is removed; unrelated hosts, profiles,
sign-ins and Jelly data remain. Existing live native connections require explicit
disconnect (or later normal shutdown) to revoke immediately.

Activating server changes is separate from installation/global opt-in. The parent
operator should review the remaining gates, then use `AGENTS.md`'s queued idle
restart, respecting all restart holds, and verify loopback/Tailscale afterward.
Do not restart Jelly inline from an agent run. Tests do not perform activation.
