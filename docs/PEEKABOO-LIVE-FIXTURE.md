# Official-release Mac fixture (operator / parent only)

This is a scoped manual/tool harness, **not a shell automation script**. Detached
workers have no native desktop access. All automated native observation/input
must go through the parent's `desktop_*` tools; do not invoke CLI/MCP, AppleScript,
AX helpers or a browser to bypass a desktop refusal.

## Install and configure explicitly

1. Obtain the official unmodified **4.9.0** Peekaboo.app and standalone CLI from
   [the release](https://github.com/openclaw/Peekaboo/releases/tag/v4.9.0).
   Use the matching machine architecture. Do not rebuild, re-sign, or use the app
   bundle executable as the CLI. The previously verified arm64 artifacts are in
   temporary research storage; installation is an operator action, not something
   this fixture performs.
2. The operator installs/opens the official GUI app and grants its Accessibility,
   Screen Recording (for images) and Event Synthesizing (for relevant input)
   permissions using macOS UI. Never grant generic Bun/Node access.
3. In Jelly Settings → Tools → Native Mac desktop, choose the standalone CLI,
   `/Applications/Peekaboo.app` (or its actual absolute location), and the exact
   canonical `~/Library/Application Support/Peekaboo/bridge.sock` as an absolute
   path. No alternate socket/host fallback is used.
4. Grant **only** `com.apple.calculator` and `com.apple.TextEdit`. Keep screenshots
   off initially. Save, connect and explicitly resume the intended parent run.
   Do not edit the live database/config file or user-wide MCP to configure this.
5. The operator opens Calculator and creates a disposable, unsaved TextEdit
   document containing only `Jelly synthetic fixture`. Close unrelated document
   windows in those two allowed apps. Do not use any real credentials or personal
   document content. Fixture cleanup is also an explicit operator action.

## Scoped tool sequence and assertions

- `desktop_status`: record actual available capabilities/permissions. A missing
  permission is a factual limitation, not a certification flag to waive.
- `desktop_apps`: select the two exact allowlisted bundles using returned opaque
  appRefs. `desktop_windows`: select only their disposable windowRefs. Candidate
  inventories are discovery, not input authority.
- `desktop_observe({windowRef})`: expect roles, opaque refs and honest unknown
  completeness/privacy; no raw values, labels, titles, PIDs or native snapshot IDs.
  A non-fresh observation may be inspected but must not authorize input.
- On TextEdit, use a fresh enabled field elementRef with `desktop_type` to append
  a short non-secret literal. Observe again immediately. Have the operator verify
  the disposable document changed; don't infer success from tool prose or retry
  an unverified dispatch. `desktop_key` can exercise an allowlisted navigation
  key on a fresh observationRef. No clipboard/command/control/option chords.
- Enable screenshot consent explicitly in Settings if desired, reconnect/resume
  as required, and re-observe the disposable exact window with `screenshot:true`.
  Confirm a native image attachment, not base64 text. Images can persist in chat
  and be sent to the model; they are not guaranteed secret-free.
- Use a fresh Calculator button elementRef, or current screenshot observationRef
  plus in-image x/y pixels, with `desktop_click`. Native background delivery may
  refuse an unavailable receiver; never escalate to foreground or replay the old
  click. Re-observe and verify each accepted action before another.
- Where the disposable TextEdit document exposes a scroll element, exercise
  `desktop_scroll({elementRef,direction:"down",amount:1})`, then observe afresh.
  Missing AX scroll support is an acceptable factual refusal, not justification
  for global wheel input. Menu mutation/foreground are not implemented by this
  reference-bound adapter; no raw selector fallback.
- Reusing any consumed element/observationRef must refuse. Move/resize the window
  manually, then verify old snapshot input refuses or requires fresh observation;
  never reconstruct authority from a raw ID.
- Request private handoff through `request_desktop_handoff`; wait for the confirmed
  private-safe state before the operator uses the Mac. Return control explicitly.
  Do **not** enter credentials as a test. Record that all late images/input are
  suppressed and old refs remain unusable.

## Loss/cancellation cases

Use fake tests for routine fault injection. If a parent-authorized live operation
is cancelled or loses its response, expect unsafe quarantine and blocked private
entry. Stop that fixture sequence; do not kill/restart a proxy, query permissions,
delete locks or repeat input to claim recovery. Healthy `delivery_accepted` with
unverified _effect_ instead permits fresh observation; `operation_still_running`
and unknown completion do not. No automatic replay is part of this harness.

Record the official versions, actual capability/permission booleans, fixture
steps, observed outcomes and limitations. The detached worker has performed none
of these live steps; passing fake tests is not a claim otherwise.
