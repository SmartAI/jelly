# Released 4.9.0 wire fixtures

Synthetic, source-shaped fixtures — **not live Mac captures or qualification evidence**.
Source: official tag `v4.9.0`, commit `7020aedd362038043e4fc1988a8634657270e476`.
No vendor patch is needed to produce these fields.

- `apps.json`: `Apps/CLI/.../Commands/System/AppCommand+List.swift`, `AppInfo` / `ListResult`.
  The numeric generation deliberately exceeds JavaScript's safe integer range;
  only the released decimal-string field is authority.
- `windows.json`: `WindowCommand+List.swift` and AutomationKit `Core/Models/Application.swift`.
  IDs/bounds are discovery hints, not a caller-pinned mutation receipt.
- `inspect-ui.json`: `InspectUITool.swift`, `ObservationActionResultSupport.swift`,
  `ObservedElementTableMetadata.swift`, `UIElementSummary.swift`, and
  `DesktopTargetIdentity+Projection.swift`. The public MCP projector retains
  target receipts, opt-in element tables/snapshot IDs and cache evidence, but not
  truncation/security-subrole completeness. Those limitations stay unknown.
- `delivery-accepted.json`: Foundation `DesktopActionOutcome.swift` and the MCP
  outcome projector. Semantic delivery acceptance is not semantic effect proof.
  The released native Bridge client validates operation receipts; still-running,
  lost or cancelled responses must not be treated as healthy completion.

`tests/peekaboo-release.test.ts` passes these through the actual SDK's in-memory
transport and the production mapping functions, then tests controller references,
redaction, image consent, dispatch consumption and quarantine. It launches no
Peekaboo process and reads no live desktop configuration or application.
