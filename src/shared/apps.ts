export type AppCorner =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";
export interface AppGatewayIdentity {
  instanceId: string;
  appId: string;
  deploymentRevision: string;
}
export interface AppObservation {
  serviceState: "unknown" | "starting" | "running" | "stopped" | "failed";
  httpHealthy: boolean | null;
  checkedAt: string | null;
  tailnetReachable: boolean | null;
  lastError: string | null;
}
export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  iconAssetId: string | null;
  projectId: string | null;
  builderAgentId: string | null;
  sourceDirectory: string | null;
  managementMode: "managed" | "linked";
  launchMode: "embedded" | "direct";
  runtimeSocket: string | null;
  gatewayPort: number | null;
  unitName: string | null;
  deploymentRevision: string | null;
  executable: string | null;
  args: string[];
  healthPath: string | null;
  localOrigin: string | null;
  tailnetOrigin: string | null;
  allowedJellyOrigins: string[];
  desiredState: "draft" | "deploying" | "ready" | "stopped";
  starredAt: string | null;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
  viewerCorner: AppCorner;
  observation: AppObservation;
}
export interface AppsCapabilities {
  supported: boolean;
  platform: string;
  systemd: boolean;
  lingering: boolean;
  tailscale: boolean;
  tailnetAddresses: string[];
  tailnetHostname: string | null;
  managedDeployment: boolean;
  /** Reviewed restricted HttpOnly/HMAC gateway only; not arbitrary-cookie compatibility. */
  embedding: boolean;
  gatewayNode: boolean;
  gatewayNodeVersion: string | null;
  privateHttps: false;
  cookieIsolation: "http-only-prefixed";
  warnings: string[];
}
export interface AppsPage {
  starred: AppRecord[];
  history: AppRecord[];
  after: string | null;
  capabilities: AppsCapabilities;
}
export interface AppCommand {
  executable: string;
  args: string[];
}
export interface AppManifest extends AppCommand {
  id?: string;
  name: string;
  slug?: string;
  description?: string;
  projectId?: string;
  builderAgentId?: string;
  sourceDirectory: string;
  build?: AppCommand;
  test: AppCommand;
  healthPath?: string;
  launchMode?: "embedded" | "direct";
  viewerCorner?: AppCorner;
  environmentFiles?: string[];
  migrationPlan?: string;
}
