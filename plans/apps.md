# Apps: trusted launcher direction

This replaces the former managed-deployment plan. Jelly Apps is a metadata registry and iframe-only launcher for owner-trusted, independently hosted HTTP(S) web apps. See [the implementation/acceptance plan](apps-trusted-iframes.md) and [current product guide](../docs/APPS.md).

- Add with name and one canonical browser URL; retain stable identity, icons, description, attribution, explicit stars and history.
- Every tile opens `/apps/:id` with the registered URL directly in a frame. Persistent **Back to Apps** restores scroll/focus.
- No deployment/runtime adoption, gateways, lifecycle/log tooling, proxies, alternate launch modes, app bridge or SDK.
- Same-host different-port is allowed with accepted cookie sharing, including HttpOnly cookies at app servers. Tailscale is private network access, not app isolation.
- Keep Jelly session/CSRF and exact control-origin checks; app registration never grants control API privileges. Jelly stays unframeable.
- Framing headers, HTTPS/HTTP compatibility and framed authentication require app configuration. Load events are not rendering proof; show honest help/retry/edit controls.
- Jelly's network transport uses native HTTP listeners on loopback and discovered Tailscale addresses, not fixed TCP piping. Dev uses native Vite listeners with the existing loopback HTTP/WS API proxy.

The operator explicitly confirmed **no existing apps/installations**, so migrations and backward compatibility are out of scope. Implementation uses disposable fixtures only. No Wealthboard registration, service restart, live database edits or remote-device success is implied. Live activation, real app compatibility and separate-device verification remain owner acceptance steps.
