# Apps: trusted iframe launcher

Status: implementation complete with disposable fixture checks; activation and real-app/remote-device acceptance pending. This replaces the former managed-deployment direction in `plans/apps.md`. The operator explicitly confirmed NO EXISTING APPS/installations, overriding all migration/backward-compatibility requirements below. No live database, app service or Wealthboard registration was changed.

## Decision

Jelly Apps is a launcher for owner-trusted web apps. Every app opens in an iframe inside Jelly. Adding an app requires only a name and URL; no launch-mode selector, direct-launch fallback, proxy mode, build pipeline, or runtime adoption.

Existing apps own their hosting, authentication, updates, persistence, and availability. Jelly owns registration, tiles, viewer navigation, and display preferences. Tailscale remains the private network access layer, not an application isolation boundary.

Initial acceptance case: register Wealthboard at `http://box.tailbfab3f.ts.net:3007` and display its existing UI inside Jelly without rebuilding it, relocating its database, or changing its running services.

## Acceptable security posture change

The owner explicitly accepts registered apps as trusted software, rather than mutually untrusted tenants:

- Same-host applications on different ports are allowed. Cookies are not port-scoped; matching cookies may be sent to those app servers, including HttpOnly cookies. Apps may set cookies that collide with or interfere with Jelly cookies.
- A compromised or malicious registered same-host app can threaten Jelly session confidentiality, integrity, and availability. This is accepted trust transitivity, not a risk solved by an iframe, SameSite, or Tailscale.
- Jelly will no longer promise app-specific cookie isolation, independent-host separation, enforced Unix-socket serving, or TCP-listener quarantine for registered apps.
- Browser same-origin rules still apply to distinct origins, but must not be described as cookie separation. Arbitrary same-origin pages cannot be made isolated simply by framing them.
- Tailscale limits network reachability and encrypts traffic between peers. It does not provide per-app authorization or protection from a compromised trusted app. HTTP remains outside a browser secure context.
- This posture is for the owner-controlled private deployment. It is not a security model for public hosting, untrusted app catalogs, or mutually untrusted users.

Document this boundary in Apps help and the registration UI with a concise trust notice, without requiring a recurring approval flow:

> Only add apps you trust. Apps sharing Jelly's hostname may receive or interfere with Jelly cookies. Tailscale protects network access, not isolation between apps.

Preserve Jelly authentication, CSRF protection, exact control-origin checks, HttpOnly/appropriate Secure and SameSite cookie attributes, and protection against framing Jelly itself. A distinctive Jelly cookie name reduces accidental collisions but is not a security boundary. Registering an app must not grant its origin access to Jelly's control API or add it to the control-origin allowlist.

## Target design

### Registry and API

- Retain stable app IDs, names, URLs, icons/descriptions where already supported, stars, ordering, visit history, and useful project/agent attribution.
- One canonical browser-reachable URL per app. Accept HTTP and HTTPS URLs, including same-host different-port and private Tailscale addresses.
- Reject executable/non-web schemes, embedded URL credentials, and attempts to register Jelly's own viewer recursively. Do not store secrets or bearer tokens in URLs or metadata.
- Authenticate reads and require session plus CSRF for mutations, as today.
- Registration stores metadata only; do not fetch arbitrary URLs from the server to validate them. It does not prove health or reachability.
- Simplify `apps_register`, `apps_get`, and `apps_list` around this model. Keep explicit starring; never auto-star on registration.
- The browser must be able to reach the configured URL. Explain that localhost on a phone refers to the phone; do not silently rewrite hosts.

### Viewer

- Every tile opens `/apps/:id`, which renders the registered URL directly in an iframe.
- Keep a persistent, accessible Jelly-owned Back to Apps control outside the iframe. Restore Apps scroll and tile focus on return.
- No open-in-new-tab mode or fallback, proxy, mandatory bridge, app-specific home link, or app-side SDK.
- Choose and test iframe permissions for trusted application functionality. Avoid restrictions presented as isolation guarantees; retain prevention of unsolicited replacement of the top-level Jelly UI where practical. Do not require unrestricted top navigation or popups as a workaround for unsupported authentication.
- Configure Jelly's framing CSP to permit intended HTTP/HTTPS app destinations without weakening script policy or control API origin policy.
- Keep loading and failure guidance honest: iframe load events do not establish successful rendering, and cross-origin framing failures cannot always be diagnosed programmatically.

### Browser compatibility boundary

All apps use the same iframe presentation, but not every arbitrary website can be embedded:

- Target CSP `frame-ancestors` and `X-Frame-Options` must permit Jelly. Do not strip or bypass these headers.
- HTTPS Jelly cannot embed HTTP apps; report the configuration mismatch and require compatible hosting.
- Browser third-party-cookie policies and framed login restrictions still apply. Some apps need their own configuration changes; some will remain incompatible.
- Show in-viewer configuration guidance and retry/edit controls. Do not claim universal embedding or offer a second launch mode.

## Remove deployment responsibilities

Remove managed deployment, gateway provisioning, release snapshots, environment-file deployment manifests, lifecycle control tools, socket requirements, listener quarantine, cookie rewriting, app-specific cookie authentication, and mandatory health endpoints from the target Apps feature.

Do not replace these with an implicit reverse proxy. Apps remain independently operated services. Deployment-oriented code, tools, schema migrations, templates and documentation are retired wholesale: there are no existing apps/installations to retain. Unrelated schema migrations remain intact.

## Migration and backward compatibility — skipped by explicit override

The parent/operator verified the live registry was empty and no app/gateway services were installed. Historical not-found failed units do not represent installations. The user explicitly requested no migration or backward compatibility, so registry backups, data migration/restore fixtures, per-app cutover, legacy ownership/resource controls and temporary compatibility layers are **not applicable**. No live registry/data/credentials or existing external app services are touched. Any unused physical deployment tables in an old empty database remain inert; the source contains no provisioning tables, columns or Apps data migrations. Fresh databases contain metadata/visit/icon tables only.

## Implementation checklist

- [x] Inspect current Apps registry, API/tool schemas, viewer, deployment services, and tests; identify precise migration boundaries.
- [x] Implement simple trusted URL registration with same-host different-port support.
- [x] Implement the single iframe viewer flow, persistent navigation, and honest compatibility guidance.
- [x] Update agent-facing tooling and instructions so adding an existing app never triggers deployment or service adoption.
- [x] Add trust notice and replace isolation claims in documentation and capability reporting.
- [x] Migration/legacy obligations explicitly skipped by user override (not implemented or tested).
- [x] Remove obsolete deployment interfaces and code after compatibility obligations are met.
- [x] Update `docs/APPS.md`, `plans/apps.md`, relevant README sections, templates, and security tests to distinguish accepted risks from retained protections.

## Validation and acceptance

- [x] Disposable same-host different-port app fixture registered without service changes; Tailscale HTTP/HTTPS URLs validated as metadata. Native listeners tested at discovered Tailscale addresses from this host. Real Tailscale-hosted app browser/device verification remains pending.
- [x] Tile opens only the iframe viewer; Back to Apps restores scroll and focus in desktop and phone-width Chromium (not real-device acceptance).
- [x] Verify scripts, forms, navigation, streaming, and WebSockets with representative apps; exercise reloads and app downtime.
- [x] Cover CSP/XFO blocked framing, real HTTPS/HTTP mismatch, invalid URLs, recursive viewer targets and unreachable hosts. Framed-auth/third-party-cookie guidance was exercised with a 401 login fixture; real site-specific OAuth/cookie behavior remains pending. No direct-launch fallback appears.
- [x] Unauthorized and CSRF-invalid registration/edit/delete attempts remain rejected. Registered origins gain no control API privileges.
- [x] Use disposable browser fixtures to demonstrate and document accepted cross-port cookie sharing. Never expose real session cookies in logs or test output.
- [x] Migration/restore acceptance skipped by explicit no-existing-apps override; no live service/data changes.
- [x] `bun run check` passed after implementation and parent review fixes: 424 tests, 0 failures; TypeScript, production client and Chrome extension builds passed. Parent owns activation/restart hold; worker did not schedule or perform restart.
- [ ] Register and verify Wealthboard inside Jelly from the local browser and a separate Tailscale device. Report remote verification as pending until actually observed.

## Non-goals

Public exposure, an app marketplace, multi-tenant isolation, generic website compatibility hacks, proxying arbitrary destinations, app deployment, process supervision, and changes to Wealthboard's database or current service lifecycle.

## Implementation evidence

- Registry: metadata + one canonical URL; stable identity/attribution/icons/stars/history/corner; no server fetch. Name-only creation uses bounded unique slugs, while explicit IDs/slugs identify updates; colliding/100-character names and multiline descriptions have regression coverage. URL credentials/query/fragment/non-web/recursive viewer validation, session/CSRF/control-origin protections retained.
- Viewer: direct registered iframe at `/apps/:id`, persistent Back with scroll/focus, no bridge/modes/proxy, scripts/forms/downloads permitted and practical popup/top navigation restrictions, honest compatibility help/retry/edit.
- Removed: app provisioning/runtime adapters/services/gateways/sockets/isolation/auth-cookie rewriting, release manifests/lifecycle/log/health/quarantine, obsolete tools/APIs/types/Apps DB migrations/templates/tests/scripts.
- Networking: fixed TCP piping removed. Shared native Bun HTTP listeners on loopback + discovered Tailscale addresses; native Vite listeners in private dev keep its existing HTTP/WS API proxy. No live service restart or port-5173 development process.
- `bun run test:apps`: 33 tests passed, including exact origin/CSRF/browser-cookie policy, native loopback/Tailscale IPv4/IPv6 HTTP/SSE/VNC WebSocket handlers, and native Vite SPA/private-files/API/finite-streaming/HMR fixtures from this host.
- `bun run test:apps-browser`: disposable Chromium passed at 1280/390/320px; scripts, forms, streaming/WebSockets, internal navigation/reload, Back/scroll/focus, accepted same-host HttpOnly sharing, framing denial/login guidance, real HTTPS→HTTP rejection and downtime recovery. No real cookie values printed.
- Development validation: the initial in-process infinite-SSE teardown fixture did not drain. A subsequent disposable native dev-launcher subprocess, using the actual backend entrypoint with temporary data and ephemeral-port/import substitutions, exited with code 0 on SIGTERM with an active SSE client. Private instance/configuration/socket directories are excluded from Vite watching and covered by a real-socket regression test. Native direct SSE teardown and finite Vite streaming/HMR also pass; the existing fixed HTTP/WS development API proxy is retained.
- Independent review: security found no blockers; product found implicit-name registration overwrite, long-name slug and multiline-description defects. Parent reproduced and fixed all three, then reran the complete check and Chromium viewer fixtures.
- Pending: reviewed activation; Wealthboard registration and observed local/independent Tailscale-device embedding; real Safari/iPhone/PWA and site-specific third-party-cookie/OAuth flows. Simulated phone-width Chromium is not real-device acceptance.
