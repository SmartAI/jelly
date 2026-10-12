# Bun persistent-app template

Copy all files here into the project's app directory. Read [the Apps guide](../../docs/APPS.md) before deploying. No dependencies, development server, watcher or build step are required.

- Production command: absolute Bun executable with `args: ["server.ts"]`.
- Required test command: absolute Bun executable with `args: ["test", "app.test.ts"]`.
- Health endpoint: `/health` checks persistent note data and returns no private configuration.
- Storage: `APP_DATA_DIR/note.json`, outside replaceable source/releases; a restart never replaces an existing note. The sample is read-only over HTTP. Add authentication and CSRF-safe writes when adapting it, not a public save endpoint.
- Mandatory server environment: mandatory absolute `APP_SOCKET` in an owner-only directory, `HOST=127.0.0.1`, `PORT=0`, absolute `APP_DATA_DIR`, `JELLY_APP_ID`, JSON-encoded string array of exact `JELLY_ALLOWED_ORIGINS`.
- Optional metadata: `JELLY_VIEWER_CORNER` (defaults to `top-left`). Jelly supplies these values for managed deployments; do not override them with secret environment files.

`index.html` reserves safe-area corner clearance. `jelly-bridge.mjs` keeps the direct home link visible until an exact-origin/source/app-ID viewer handshake is validated. Only `/apps` is a return destination; query strings/referrers never configure home. Route reports exclude query/hash, encodings and traversal. `frame-ancestors` permits only configured Jelly origins; choose direct mode rather than loosening incompatible security headers.

The template uses no session cookies. Managed gateways support the reviewed restricted **forced-HttpOnly + per-app HMAC** mode, not arbitrary JavaScript session-cookie applications. Real Chromium tests prove confidentiality/integrity, duplicate/shadow rejection, replay/deletion and Jelly-control protection. Shared-host cookie-jar exhaustion and injected Path/Domain shadows can still deny availability. Apps requiring `document.cookie`, arbitrary cookie compatibility or stronger availability separation need independent hosts and host-only cookies. Direct launch does not waive isolation. Sensitive apps need their own sign-in; same-OS-user app code is not a filesystem/process sandbox.

Managed deployment requires Linux/systemd user services, verified lingering, readable cgroup-v2/`/proc`, persistent Bun and Node.js >=20. The runtime uses `Bun.serve({unix: APP_SOCKET, fetch: ...})`, never a TCP port; TCP-only apps fail closed. Node production apps can use `server.listen(process.env.APP_SOCKET)`. Build/test receive disposable storage/socket paths; runtime receives durable storage and a short instance/app-scoped socket independent of data-directory length. Gateway streaming and WebSockets use that fixed Unix upstream. Units and owner markers include immutable instance identity as well as app ID; legacy ID-only units are not adopted. `JELLY_ALLOWED_ORIGINS` is JSON, for example `["http://127.0.0.1:5173","http://box.tailfixture.ts.net:5173"]`, not CSV.
Before data-format changes, back up and verify restore on temporary copies, retain old/new read compatibility or document downtime, and supply a concrete `migrationPlan`. Code rollback does not undo data migrations. Keep secret values in owner-only external environment files referenced by path; never commit, return or log them.

Current capabilities have no built-in private HTTPS (`privateHttps:false`); the gateway is HTTP-only. Never embed it in HTTPS Jelly. Direct HTTP fallback must state secure-context/isolation limitations and does not supply TLS; independent private HTTPS provisioning remains separate.

After explicit `apps_deploy`, link its enriched viewer URL and report returned health and pending/failed remote verification accurately. Do not star automatically or treat passing template tests as a deployment result.

Runtime cgroup descendants are checked for any TCP listeners before readiness and during lifecycle/observation; unsafe bindings stop both owned services. Unit bind denial is defense-in-depth where user-manager privileges permit, not a same-user sandbox; ordinary outbound HTTP remains supported. Changing deployed launch mode requires redeployment, and omitted mode preserves direct policy. Unregistering a deployed app leaves services running but loses Apps controls and blocks same-ID re-registration/later Apps uninstall; choose uninstall now or perform verified manual cleanup later.
