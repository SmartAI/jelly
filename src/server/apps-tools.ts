import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../shared/types";
import type { AppsService } from "./apps-service";

export const APPS_INSTRUCTIONS =
  "Jelly has an Apps Home Screen at /apps. When explicitly asked to build and publish a persistent web app, inspect Apps capabilities with instance_info/apps_list, build it in its project, test it, and publish with apps_deploy or apps_register. Use production user services and private loopback/Tailscale gateways, not temporary development servers or public exposure. Include Jelly home navigation; follow docs/APPS.md and templates/apps. Never claim an app is live until deployment and health checks succeed; distinguish local health from pending remote verification. Link the returned viewer URL in your final response. Do not auto-publish previews or unfinished prototypes, and never auto-star an app: use apps_set_starred only when the user asks. Keep secret values out of tool arguments, manifests, registry metadata, URLs and logs; use protected environment-file references. Managed runtimes must serve APP_SOCKET, never a TCP listener. Unregistering keeps the service running but loses Apps controls and prevents re-registering that same ID or later Apps-based uninstall; choose uninstall now if desired, otherwise later cleanup is manual.";

// Keep these wrappers usable with a fake service, without a second registry or lifecycle implementation.
export type AppsToolsService = Pick<
  AppsService,
  | "list"
  | "get"
  | "register"
  | "setStarred"
  | "capabilities"
  | "deploy"
  | "control"
  | "logs"
  | "remove"
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
const launchMode = Type.Optional(
  Type.Union([Type.Literal("embedded"), Type.Literal("direct")]),
);
const viewerCorner = Type.Optional(
  Type.Union([
    Type.Literal("top-left"),
    Type.Literal("top-right"),
    Type.Literal("bottom-left"),
    Type.Literal("bottom-right"),
  ]),
);
const command = Type.Object(
  {
    executable: Type.String({
      minLength: 1,
      maxLength: 4096,
      description: "Absolute executable path; no shell command.",
    }),
    args: Type.Array(Type.String({ maxLength: 4096 }), {
      maxItems: 100,
      description:
        "Literal arguments; {socket} and {dataDir} substitutions only. Managed runtime must accept APP_SOCKET; no TCP {port}.",
    }),
  },
  { additionalProperties: false },
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
      "Read the current Jelly instance, agent identity, Apps Home URL and deployment/network capabilities.",
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
        "Read an app's ownership, status, private URLs, viewer link and current capabilities. Does not launch it.",
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
        "Explicitly create/update app metadata or link an existing private app without owning its service. New apps are unstarred and default to this builder/project; updates preserve ownership unless supplied, stars and visit history. Socket paths, gateway ports, units and managed origins are server-owned. Omitted linked origins are preserved; null clears the specified origin. Changing a deployed launch mode requires redeployment. Registration is not proof of health.",
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
          managementMode: Type.Optional(
            Type.Union([Type.Literal("managed"), Type.Literal("linked")]),
          ),
          launchMode,
          viewerCorner,
          url: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 2048,
              description:
                "Existing private independent-host origin; linked apps always open directly.",
            }),
          ),
          localOrigin: optionalNullableText(2048),
          tailnetOrigin: optionalNullableText(2048),
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
        "Set a specified star state only when the user asks to star/unstar this app. Idempotent; never infer starring from creation, deployment or use. Does not start/stop the service or record a launch.",
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
      name: "apps_deploy",
      label: "Deploy persistent app",
      description:
        "Explicitly build, test and deploy a production app using Jelly-owned persistent user services and private gateways. Inspect capabilities first. Server allocates an owner-only instance/app Unix socket, gateway port and instance-scoped units; verifies exact socket/gateway health and rejects all owned-cgroup TCP listeners before success. Runtime must accept APP_SOCKET; TCP-only apps fail closed. Omitted launchMode preserves the existing mode. Retain runtime data outside releases; migrations require backup/compatibility plans. Never pass secrets, shell commands, arbitrary ports or units. New apps default to this builder/project and are never auto-starred.",
      parameters: Type.Object(
        {
          id: Type.Optional(id),
          name: Type.String({ minLength: 1, maxLength: 100 }),
          slug: optionalText(80),
          description: optionalText(4000),
          projectId: optionalText(80),
          builderAgentId: optionalText(80),
          sourceDirectory: Type.String({ minLength: 1, maxLength: 4096 }),
          executable: command.properties.executable,
          args: command.properties.args,
          build: Type.Optional(command),
          test: command,
          healthPath: Type.Optional(
            Type.String({ minLength: 1, maxLength: 512, default: "/health" }),
          ),
          launchMode,
          viewerCorner,
          environmentFiles: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
              maxItems: 20,
              description:
                "Absolute paths to protected environment files; never inline secret values.",
            }),
          ),
          migrationPlan: optionalText(8000),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, manifest, signal) => {
        signal?.throwIfAborted();
        const app = await apps.deploy(manifest, defaults);
        return result({
          app,
          viewerUrl: `/apps/${encodeURIComponent(app.id)}`,
          localUrl: app.localOrigin,
          tailnetUrl: app.tailnetOrigin,
          unitName: app.unitName,
          health: app.observation,
          remoteVerificationPending: app.observation.tailnetReachable === null,
        });
      },
    }),
    define({
      name: "apps_control",
      label: "Control app service",
      description:
        "Explicitly start, stop or restart a Jelly-owned app without affecting Jelly or other apps. Linked apps cannot be controlled. Starring/un-starring is unrelated to lifecycle.",
      parameters: Type.Object(
        {
          id,
          action: Type.Union([
            Type.Literal("start"),
            Type.Literal("stop"),
            Type.Literal("restart"),
          ]),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        return result(await apps.control(input.id, input.action));
      },
    }),
    define({
      name: "apps_logs",
      label: "Read app logs",
      description:
        "Read bounded, best-effort redacted diagnostics from a Jelly-owned app. Redaction is not a guarantee; app authors must never log secrets.",
      parameters: Type.Object(
        {
          id,
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        return result(await apps.logs(input.id, input.limit));
      },
    }),
    define({
      name: "apps_remove",
      label: "Remove app",
      description:
        "Explicitly unregister an app (uninstall:false leaves its service running), or uninstall only its Jelly-owned service/gateway and unregister (uninstall:true). Neither deletes source code or app data. Linked apps cannot be uninstalled. Unregistering a deployed app loses Apps controls, blocks re-registration of that ID and prevents later Apps-based uninstall; subsequent cleanup is manual. Explain the distinction before acting.",
      parameters: Type.Object(
        { id, uninstall: Type.Boolean() },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        return result(
          await apps.remove(input.id, { uninstall: input.uninstall }),
        );
      },
    }),
  ];
}
