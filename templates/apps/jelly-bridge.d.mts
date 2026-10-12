export function validRoute(route: unknown): route is string;
export function jellyOrigins(origins: unknown): string[];
export function installJellyBridge(options: {
  appId: string;
  allowedOrigins: string[];
  homeLink: HTMLAnchorElement;
  win?: Window;
}): { reportRoute(route: string): boolean; close(): void };
