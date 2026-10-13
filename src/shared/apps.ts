export type AppCorner =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Registration is metadata, not a hosting or reachability guarantee. */
export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  url: string;
  description: string;
  iconAssetId: string | null;
  projectId: string | null;
  builderAgentId: string | null;
  sourceDirectory: string | null;
  starredAt: string | null;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
  viewerCorner: AppCorner;
}
export const APP_TRUST_NOTICE =
  "Only add apps you trust. Apps sharing Jelly's hostname may receive or interfere with Jelly cookies. Tailscale protects network access, not isolation between apps.";
export interface AppsCapabilities {
  supported: true;
  presentation: "trusted-iframe";
  registrationOnly: true;
  warnings: string[];
}
export const appsCapabilities = (): AppsCapabilities => ({
  supported: true,
  presentation: "trusted-iframe",
  registrationOnly: true,
  warnings: [
    APP_TRUST_NOTICE,
    "Apps own their hosting, authentication and availability. Framing policies and browser login restrictions may prevent embedding.",
  ],
});
export interface AppsPage {
  starred: AppRecord[];
  history: AppRecord[];
  after: string | null;
  capabilities: AppsCapabilities;
}
