import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../shared/types";
import type { AppsService } from "./apps";

export const APPS_INSTRUCTIONS =
  "Jelly Apps is a trusted web-app launcher at /apps. Adding an existing app requires only its name and browser-reachable HTTP(S) URL via apps_register; do not deploy, adopt, proxy or modify its service. Every tile opens /apps/:id with that exact URL in an iframe. Apps own hosting, authentication, updates and availability. Only register apps the owner trusts: same-host ports can receive or interfere with Jelly cookies; Tailscale is network access, not app isolation. Inspect docs/APPS.md for framing/login compatibility. Registration does not verify reachability; report local browser and remote-device verification separately. When asked to build an app, build/test in its project and ask before registration or external hosting changes. No app SDK or home link is required. Never auto-star; apps_set_starred requires an explicit user request. Keep secrets out of metadata and URLs. apps_remove only unregisters metadata, never stops services or deletes source/data.";

// Keep these wrappers usable with a fake service, without a second registry implementation.
export type AppsToolsService = Pick<
  AppsService,
  "list" | "get" | "register" | "setStarred" | "capabilities" | "remove"
>;
const define = <T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition =>
  tool as ToolDefinition;
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const id = Type.String({ minLength: 1, maxLength: 80 });
const optionalText = (maxLength: number) =>
  Type.Optional(Type.String({ maxLength }));
const optionalNullableText = (maxLength: number) =>
  Type.Optional(Type.Union([Type.String({ maxLength }), Type.Null()]));
const viewerCorner = Type.Optional(
  Type.Union([
    Type.Literal("top-left"),
    Type.Literal("top-right"),
    Type.Literal("bottom-left"),
    Type.Literal("bottom-right"),
  ]),
);
export function instanceInfoTool(
  instance: { id: string; name: string },
  agent: Pick<AgentRecord, "id" | "name" | "projectId">,
  apps?: Pick<AppsToolsService, "capabilities">,
): ToolDefinition {
  return define({
    name: "instance_info",
    label: "Workspace info",
    description:
      "Read the current Jelly instance, agent identity, Apps Home URL and trusted launcher capabilities.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_id, _args, signal) => {
      signal?.throwIfAborted();
      return result({
        instance,
        agent: { id: agent.id, name: agent.name, projectId: agent.projectId },
        runtime: "Pi",
        storage: "SQLite",
        apps: {
          homeUrl: "/apps",
          capabilities: apps ? await apps.capabilities() : null,
        },
      });
    },
  });
}

export function appsTools(
  apps: AppsToolsService,
  agent: Pick<AgentRecord, "id" | "projectId">,
): ToolDefinition[] {
  // The service applies these only when inserting; idempotent slug updates must retain ownership.
  const defaults = { builderAgentId: agent.id, projectId: agent.projectId };
  return [
    define({
      name: "apps_list",
      label: "List apps",
      description:
        "Read Apps registry and current capabilities. Starred apps precede paginated unstarred history; this does not record a launch.",
      parameters: Type.Object(
        {
          q: optionalText(200),
          after: optionalText(2000),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 100, default: 30 }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, query, signal) => {
        signal?.throwIfAborted();
        return result({
          ...apps.list(query),
          capabilities: await apps.capabilities(),
        });
      },
    }),
    define({
      name: "apps_get",
      label: "App details",
      description:
        "Read an app's metadata, canonical URL, viewer link and current capabilities. Does not launch it.",
      parameters: Type.Object({ id }, { additionalProperties: false }),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        const app = apps.get(input.id);
        return result({
          app,
          viewerUrl: `/apps/${encodeURIComponent(app.id)}`,
          capabilities: await apps.capabilities(),
        });
      },
    }),
    define({
      name: "apps_register",
      label: "Register app",
      description:
        "Create/update trusted app metadata using name and URL. New apps are unstarred; updates retain identity, attribution, stars and history. Registration never probes the URL or changes hosting. Every app opens in the iframe viewer; framing or login restrictions may prevent embedding.",
      parameters: Type.Object(
        {
          id: Type.Optional(id),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          slug: optionalText(80),
          description: optionalText(4000),
          iconAssetId: optionalNullableText(80),
          projectId: optionalNullableText(80),
          builderAgentId: optionalNullableText(80),
          sourceDirectory: optionalNullableText(4096),
          viewerCorner,
          url: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 2048,
              description:
                "Canonical browser-reachable HTTP(S) URL, including same-host different ports. No credentials, query, fragment or secrets.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        return result(apps.register(input, defaults));
      },
    }),
    define({
      name: "apps_set_starred",
      label: "Set app star",
      description:
        "Set a specified star state only when the user asks to star/unstar this app. Idempotent; never infer starring from creation or use. Does not start/stop the service or record a launch.",
      parameters: Type.Object(
        { id, starred: Type.Boolean() },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        return result(apps.setStarred(input.id, input.starred));
      },
    }),
    define({
      name: "apps_remove",
      label: "Remove app",
      description:
        "Unregister metadata only. Does not stop, uninstall or modify the independently hosted app, its source or data.",
      parameters: Type.Object({ id }, { additionalProperties: false }),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        return result(apps.remove(input.id));
      },
    }),
  ];
}
