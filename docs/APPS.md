# Persistent apps in Jelly

Apps is an instance-scoped launcher at `/apps`, not an HTML-preview publisher or a remote browser. Publish only when the user explicitly asks. Apps survive agent completion, browser closure and Jelly restarts. Creating or deploying an app **never stars it** and does not record a visit. Star only on a user's request with `apps_set_starred`.

## Inspect capabilities first

`instance_info` returns `apps.homeUrl` and current `apps.capabilities`. `apps_list` returns starred apps, paginated unstarred history and capabilities; `apps_get` includes ownership, observations and `/apps/:id` viewer URL. The capability fields are `supported`, `platform`, `systemd`, `lingering`, `tailscale`, `tailnetAddresses`, `tailnetHostname`, `managedDeployment`, `embedding`, `gatewayNode`, `gatewayNodeVersion`, `privateHttps: false`, `cookieIsolation: "http-only-prefixed"` and `warnings`. `embedding:true` explicitly identifies the reviewed restricted HttpOnly/app-HMAC gateway mode; the viewer fails closed if absent or false. This is not arbitrary-cookie compatibility. Read the warnings and limits below. An unsupported platform or unavailable isolation/service manager is not a successful deployment. Do not bypass a failed capability check with an ad-hoc shell daemon, raw remote runtime port, wildcard listener or direct mode.

There are two paths:

- **Managed:** `apps_deploy` builds/tests a project and activates Jelly-owned production systemd user services and a private gateway. Jelly owns Unix socket paths, gateway ports, instance-scoped unit names, deployment revisions and managed origins.
- **Linked:** `apps_register` records an already-running private app's metadata/origins without adopting its service. Use `url` (or the supported origin metadata) for a private origin on an independent host, not Jelly's hostname on another port. Linked apps always open directly; embedded mode is rejected. Registration is not a health, cookie-isolation or reachability claim. No start/stop/uninstall controls are granted to linked apps.

Builder agent and project default to the calling agent only on first insertion; explicit metadata wins. Id/slug updates preserve existing ownership unless explicitly changed, and retain stars and last-opened timestamps. Removing or archiving a builder does not remove the app. Agents never edit the registry database directly.

## Production contract

Managed deployment requires Linux, a working `systemctl --user` session, verified user lingering, readable Linux cgroup-v2 and `/proc` socket inventories, persistent absolute Bun and **Node.js >=20** executables. Node supplies the standalone production streaming/WebSocket gateway. Capability checks return actionable errors rather than claiming success if these dependencies are missing. Units are enabled for `default.target`; no root, Jelly restart or public listener is involved.

Copy `templates/apps/` into the project's app source directory. It is a runnable, dependency-free Bun HTTP app, not a dev server. The sample serves a read-only note from durable storage, deliberately has no unauthenticated write endpoint, and never exposes arbitrary source files. Adapt the UI and add appropriate application authentication/authorization before storing sensitive data. Tailnet membership is not per-app sign-in.

A managed app must obey:

| Input                   | Contract                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `APP_SOCKET`            | Mandatory server-controlled canonical Unix socket; no browser-navigable raw runtime                 |
| `HOST`                  | Forced `127.0.0.1` compatibility metadata; never use it to start a TCP listener                     |
| `PORT`                  | Forced `0`; TCP-only runtimes fail closed, not an allocated HTTP port                               |
| `APP_DATA_DIR`          | Absolute durable storage outside replaceable source/build/releases                                  |
| `JELLY_APP_ID`          | Server-assigned nonsecret app identity for the optional bridge                                      |
| `JELLY_ALLOWED_ORIGINS` | Server-controlled JSON string array of exact local/tailnet Jelly origins, not arbitrary URLs        |
| `JELLY_VIEWER_CORNER`   | Server-controlled `top-left`, `top-right`, `bottom-left` or `bottom-right` clearance/home placement |

Jelly supplies these metadata/runtime variables. Secret references belong in protected `environmentFiles`; they are not part of the registry or public API. Do not override server-owned metadata/runtime variables in those files. Launcher metadata is captured at deployment: changing Jelly origins or app corner configuration requires redeployment to update the running app's bridge/home settings.

- Start with an absolute executable and a structured argument array, not a shell string. Arguments are literal; Jelly supports `{socket}` and `{dataDir}` replacement (`{port}` is rejected), not general shell expansion, pipes, redirects, command substitution or environment substitution. Do not choose a shell executable to evade this contract.
- Provide a production `/health` returning a successful HTTP response only when the app is ready to serve. The template verifies readable, valid persistent data. No authentication secrets, configuration dumps, stack traces or filesystem paths in health responses.
- Supply a required test command and an optional build command, both executable/argument objects. Jelly injects disposable, cleaned `APP_DATA_DIR` and `APP_SOCKET` paths into both build and test (including argument substitutions), never the durable runtime directory. Use fake external dependencies; do not access the live Jelly database or production app data by another path. Same-user executable code is trusted, not sandboxed. A successful build is not proof of health.
- Persist uploads, databases and other mutable state under `APP_DATA_DIR`, not the working directory. Use owner-only permissions, bounded input, atomic writes/transactions and backups appropriate to the data. The sample exclusively creates `note.json` with mode `0600` and does not replace it on subsequent starts.
- Keep secrets in owner-readable environment files outside source/release directories, referenced by absolute path. Never send values through tools, model context, metadata, command arguments, URLs or logs. Environment-file paths may be visible as references; they are not a secret transport. Do not commit these files. Use systemd-compatible `NAME=value` syntax, not shell commands.
- Logs are bounded with best-effort redaction, **not** a guarantee against leaks. Never log passwords, tokens, cookie contents, environment dumps or private request bodies.

Example `apps_deploy` tool arguments (replace the example project/executable paths with real absolute paths):

```json
{
  "name": "Notes",
  "slug": "notes",
  "description": "A persistent private notebook",
  "sourceDirectory": "/home/me/projects/notes",
  "executable": "/home/me/.bun/bin/bun",
  "args": ["server.ts"],
  "test": {
    "executable": "/home/me/.bun/bin/bun",
    "args": ["test", "app.test.ts"]
  },
  "healthPath": "/health",
  "launchMode": "embedded",
  "viewerCorner": "top-left",
  "migrationPlan": "No schema migration. Back up APP_DATA_DIR before changes; new code reads the existing note format."
}
```

`id`, `projectId`, `builderAgentId`, `build: {executable,args}`, `environmentFiles: [absolutePath]` and a revised `migrationPlan` may also be supplied. IDs/slugs are at most 80 characters, command arrays at most 100 literal arguments, health paths at most 512 characters, and environment-file lists at most 20 references. Tools accept this manifest directly; `POST /api/apps/deploy` accepts the same JSON object. Jelly origins are server configuration, not caller-overridable registration metadata. Do not supply unit names, socket paths, runtime/gateway ports, origin overrides or inline environment/secret values in a managed deployment manifest.

Deployment succeeds only after activation, exact Unix socket/gateway health, and cgroup-wide listener checks. TCP-only managed apps are unsupported; independently hosted linked apps remain supported. Changing a deployed `launchMode` through metadata registration is rejected with a redeployment requirement; omitted mode preserves the existing gateway policy. Linked `localOrigin` and `tailnetOrigin` edits preserve omitted fields and clear explicitly supplied `null` fields. The service/HTTP deployment result is an `AppRecord`; the `apps_deploy` tool enriches it with `app`, `viewerUrl`, `localUrl`, `tailnetUrl`, `unitName`, checked `health` and `remoteVerificationPending`. The tool preserves the returned observations: pending means `tailnetReachable` is unknown, not an invented remote-health claim; an observed false value is a known reachability failure. Link `viewerUrl` in the agent's final response, and state pending/unavailable/failed remote verification accurately. A local HTTP success does not prove a phone can connect. A failed deployment should retain diagnostics and the last working release where possible; do not describe it as ready or silently replace it with a dev server.

## Storage, migrations and rollback

Release snapshots omit `.git` and `.env`/`.env.*` components in both lexical paths and resolved targets. Internal aliases cannot reintroduce excluded metadata; directory aliases are inspected recursively, outside-source symlinks and directory cycles are rejected before build/test, and every resolved copy target is checked again. Safe internal aliases remain supported.

Before a data/schema change, supply a concrete migration plan: what changes, where the backup is stored, how the backup is verified/restored, whether old/new releases can both read the data, and what downtime or user approval is needed. Back up databases consistently (for example, SQLite's backup API), not by copying only the main file while WAL writes continue. Test migration and restore against disposable copies. Ensure a failed test/build cannot migrate production data.

Code rollback does **not** roll back database migrations. Prefer backward-compatible expand/contract changes; retain and verify a backup before incompatible changes. Do not delete source or data during a redeployment or uninstall. The template uses a stable JSON note format and preserves an existing file; it refuses corrupt data rather than overwriting it with defaults.

## Home and viewer integration

The default `/apps/:id` viewer renders a cross-origin iframe with a small Jelly-owned, always-visible home pill outside the frame. It returns explicitly to `/apps`, restores Home scroll and focuses the originating app by ID; it is not `history.back()`. Browser Back may traverse iframe history, so keep the explicit home path. Safe areas and the configurable corner must remain clear; generated apps reserve at least the template's 80px corner band.

`templates/apps/jelly-bridge.mjs` is optional and uses only this protocol:

- Parent → child: `{ "type": "jelly:viewer", "appId": "…" }`.
- Child → parent: `{ "type": "jelly:ready", "appId": "…" }`.
- Child → parent: `{ "type": "jelly:route", "appId": "…", "route": "/notes" }`.

Both sides validate the exact configured origin, source window, app ID and message schema. No `*` target origin, commands or credentials. The template hides its direct **Jelly Apps** link only after a valid parent handshake; being in an iframe alone is insufficient. For direct visits it selects an allowlisted local Jelly origin on loopback, or a tailnet Jelly origin on a remote hostname, with fixed destination `/apps`. If no matching origin exists it shows an explicit unavailable link, never hands a phone a loopback URL. App IDs/origins come from server environment, never return-URL/query parameters or an untrusted referrer.

Persist only validated relative routes: a single leading `/`, maximum 2048 characters, no query/hash, backslash, control characters, dot segments or encoded unsafe characters. The template deliberately uses a conservative ASCII path subset and rejects all percent encodings. Never copy OAuth tokens or arbitrary queries into viewer URLs. `ready` means the optional bridge is present; iframe `load` or a bridge message is not proof of HTTP health or successful application rendering.

The template uses an exact `Content-Security-Policy: frame-ancestors` Jelly origin allowlist. Do not remove another application's framing headers merely to make it embed. Apps needing top-level OAuth, popups, secure-context APIs or restrictive framing use recorded `launchMode: "direct"` and the viewer's visible direct fallback. The restricted gateway permits external public HTTPS OAuth redirects only in recorded direct mode. Chromium verifies a top-level GET callback with HttpOnly/Lax state; cross-origin credentialed subresources and OAuth `form_post` callbacks are rejected. The viewer denies top navigation, unrestricted popups and fullscreen by default. Imported apps without integration open in a new tab, leaving Apps available; Jelly cannot guarantee an in-page home button on arbitrary imported content.

## Browser/network isolation and limits

App HTML must never be proxied under Jelly's own origin. Different ports provide browser origins, **not cookie isolation**. A response-header-only gateway cannot make arbitrary same-host apps safe: `document.cookie` bypasses response rewriting, and app JavaScript can shadow narrower-path cookies or exhaust a shared cookie jar even when server response cookies are forced `HttpOnly` and prefixed. Direct launch does not fix this boundary either.

The implemented restricted gateway strips Jelly control cookies/headers, accepts only app-bound HMAC-authenticated cookies, rejects duplicate names/reserved Jelly setters, prefixes server cookies, removes `Domain`, and forces **all** runtime response cookies `HttpOnly`. Chromium tests prove accepted cookie confidentiality/integrity, exact-tuple overwrite resistance, fail-closed parent-Domain/narrower-Path shadows, foreign-app replay rejection, logout/deletion and error/redirect/WebSocket cookies. This supports managed embedding in the reviewed restricted mode, not arbitrary JavaScript session-cookie applications. Shared-host cookie-jar exhaustion and injected shadows can still **deny availability**; this accepted limitation is surfaced in capabilities. Apps requiring `document.cookie`, arbitrary cookie compatibility or stronger availability separation need independent hosts and host-only cookies.

Do not broaden this proven mode into an arbitrary-cookie compatibility claim. Unverified modes must fail closed or use independent hosts with appropriate host-only cookies. Distinct sibling names alone do not defeat parent-`Domain` injection. Jelly uses `Secure; HttpOnly; Path=/` `__Host-jelly_control` on HTTPS and retires known legacy HTTP cookie paths rather than adopting their credentials; HTTP uses host-only HttpOnly cookies and rejects ambiguous current/legacy names. A distinct privately hosted linked app uses direct mode within its trust limits; **direct mode never waives isolation**.

Managed runtimes have **no raw TCP origin, including loopback**: even a loopback-only HTTP runtime would receive Jelly host cookies across ports and bypass gateway filtering. They must serve the assigned `APP_SOCKET`. Jelly maps immutable instance/app identities to short stable paths under `/tmp/jelly-as-<uid>/i<hash>/a<hash>/http.sock` (maximum 103 UTF-8 bytes), independently of long data-directory paths. All socket parents are canonical, owner-only, same-user directories with checked identity markers; symlinks, foreign markers and regular files are rejected. The persistent launcher safely recreates these directories after boot and clears only a verified stale socket after the owned unit stops. The gateway bundles its guard and uses an immutable server-controlled `socketPath`, never request-selected destinations. Gateway health also requires exact instance ID, app ID and deployment revision in gateway-stamped `X-Jelly-Instance-Id`, `X-Jelly-App-Id` and `X-Jelly-Deployment-Revision` response headers; runtime `x-jelly-*` headers are stripped first. These IDs are nonsecret, not credentials. A foreign gateway or old release answering a raced port cannot satisfy readiness; redirects remain disabled.

Before readiness and during start/restart/observation, all runtime cgroup descendants are checked for TCP listeners on **any** address/port; an unsafe binding or unverifiable live inventory stops both owned runtime and gateway and retains diagnostics. Ordinary HTTP-health failures are not classified as unsafe bindings. Runtime units also request `SocketBindDeny=ipv4:tcp ipv6:tcp`; this is defense-in-depth, not universally enforced by unprivileged user managers. The disposable-host probe showed BPF bind denial **not enforced here**, while cgroup quarantine and outbound HTTP worked. Ordinary outbound networking is retained; explicit TCP source binding is unsupported where kernel bind denial is enforced. Observations are periodic while Jelly runs, not an OS sandbox or a continuous security boundary against malicious same-user source, and close when Jelly closes.

Unit names and ownership markers include both immutable `store.instance().id` and app ID, preventing independent instances from replacing/controlling each other. Legacy ID-only units are never silently adopted or controlled; old records are made unlaunchable and require explicit operator cleanup/new deployment. Registry migration v15 retains legacy reservations rather than guessing ownership.

Do not use the development TCP forwarder as an app gateway. Gateways bind loopback and explicit discovered Tailscale addresses only, preserve streaming/WebSockets, and forward only registered destinations. Health probes must not follow redirects; gateway redirects must not expose runtime/control destinations. No Funnel, public publishing, LAN/wildcard listeners or arbitrary URL fetching. Never add app origins to Jelly's trusted control-origin list.

The centralized API guard now requires a session for all private reads/SSE and session+CSRF for every mutation, including legacy agent/config operations. Bootstrap rejects opaque/untrusted origins, same-site other-port requests without an explicit exact trusted origin, navigation/iframe/resource/no-cors use and ambiguous cookies. The client bootstraps before reads/event streams and sends CSRF for writes. Trusted development proxy aliases remain exact; app ports never become control aliases. Public health exposes only `{ok:true}`. Jelly SPA/viewer documents deny framing; intentionally sandboxed rendered previews keep their separate policy. Missing-metadata non-browser bootstrap retains the single-user loopback/private-tailnet trust model: it is not per-user login or a same-OS-user sandbox.

Tailscale ACLs still control network reachability. HTTP tailnet origins are **not** browser secure contexts. Jelly currently has **no built-in private HTTPS provisioning** (`privateHttps` is always false); the HTTP gateway does not provide TLS or secure-context APIs. Never embed HTTP content in HTTPS Jelly. Use an independently provisioned private HTTPS app where supported, or a direct HTTP fallback with its secure-context and isolation limitations stated, never a downgraded Jelly session. Direct mode does not create HTTPS or waive cookie isolation. Local apps may remain usable when Tailscale is down; remote reachability is separately observed and may remain unknown until verified.

App code runs as the same OS user in v1: it can access that user's files and is not sandboxed against malicious server-side code. Gateway/browser boundaries do not supply process or filesystem isolation. User lingering must be verified for reboot persistence; never reboot or restart Jelly merely to test a new app.

## Tools and HTTP operations

| Tool                          | HTTP operation                                                     | Purpose                                                                      |
| ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `apps_list`                   | `GET /api/apps?q=&after=&limit=`                                   | Starred + paginated history, capabilities (default 30, max 100 history rows) |
| `instance_info` / `apps_list` | `GET /api/apps/capabilities`                                       | Supported runtime/network/isolation capabilities                             |
| `apps_get`                    | `GET /api/apps/:id`                                                | Metadata and observations                                                    |
| `apps_register`               | `POST /api/apps/register`                                          | Explicit metadata creation/update or private link                            |
| `apps_set_starred`            | `POST /api/apps/:id/star` `{starred:boolean}`                      | Idempotent explicit preference, never lifecycle                              |
| UI navigation only            | `POST /api/apps/:id/launch` `{navigationId:string}`                | One launch intent per navigation, not health/deploy/tool reads               |
| `apps_deploy`                 | `POST /api/apps/deploy`                                            | Build/test/activate/check manifest                                           |
| `apps_control`                | `POST /api/apps/:id/control` `{action:"start"\|"stop"\|"restart"}` | Jelly-owned service only                                                     |
| `apps_logs`                   | `GET /api/apps/:id/logs`                                           | Bounded diagnostics (default 100, max 500 lines)                             |
| `apps_remove`                 | `POST /api/apps/:id/remove` `{uninstall:boolean}`                  | Explicit unregister vs uninstall                                             |

History cursors are bounded to 2000 characters. Logs return `{text, warning}` with best-effort redaction. Removal returns `{removed:true, serviceRetained:boolean, dataRetained:true}`. These diagnostics/results do not imply general browser compatibility or verified remote access.

HTTP writes use Jelly's existing CSRF protocol. Agent tools are normal server-side `ToolDefinition` wrappers over the same `service.apps` layer, not a separate Pi extension or database client.

**Remove from Apps** (`uninstall:false`) unregisters only; a deployed managed app continues running, but **loses Apps controls, cannot be re-registered with the same ID, and cannot subsequently be uninstalled through Apps**. Reservations remain to prevent collisions. Choose uninstall at removal time if desired; otherwise later stop/disable/removal requires manual operator systemd cleanup after verifying the instance/app ownership marker. Unregistered services also no longer have registry observers. **Uninstall service** (`uninstall:true`) stops/disables and removes only Jelly-owned service/gateway artifacts, then unregisters. Neither deletes source code or durable data. Linked services cannot be uninstalled by Jelly. Leaving an app unstarred or unused never stops, expires or deletes it. Jelly shutdown closes registry/runtime observers, not persistent app processes.

## Jelly activation helper

`scripts/restart-when-idle.sh` is a versioned helper intended for a **separate systemd user unit**, never an inline Jelly restart. It preserves owner-managed restart holds and the existing read-only idle-run check. Readiness checks loopback plus a connected, private Tailscale DNS/IP discovered locally, using public `/api/health` rather than unauthenticated private state. It does not verify an independent remote peer. The default port is 5173; set nonsecret `JELLY_RESTART_PORT` (1–65535) on the scheduled helper only if Jelly already uses another port. This does not change Jelly's listener configuration. Disconnected Tailscale, invalid port or failed health is not reported as verified. Tests source only copied discovery functions in temporary folders, never the live helper's restart loop.

## Validation without touching production

Run `bun run test:apps` for registry, deployment, API/security, tools, client and template checks; `bun run test:apps-browser` exercises the Chromium viewer; `bun run check` remains the full integration gate. The security/browser suites require installed Chromium, Node >=20 and OpenSSL for disposable TLS certificates; this is a test-fixture dependency, not built-in private TLS provisioning. Inside a copied template run `bun test app.test.ts`; tests create temporary directories and do not bind public/tailnet listeners. Service/API tests use temporary SQLite databases and fake service-manager/network adapters. An opt-in `bun run test:apps-smoke` deploys UUID-named disposable real user services against a temporary Store/copied template, checks Bun and Node Unix runtimes with the complete production-shaped origin set, cgroup-descendant TCP quarantine and outbound-network compatibility, local and actual tailnet HTTP from this host, unchanged process PIDs across temporary Jelly close, lifecycle/removal/data retention and owned cleanup. It never uses the live registry, reboots or restarts Jelly. Real iPhone/Safari and host reboot have **not** been verified; unit health cannot substitute for remote browser evidence. Do not use a live database, restart Jelly, reboot, stage or commit as part of this validation.
