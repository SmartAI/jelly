// Stable integration entry point; the implementation remains in apps.ts.
export { AppsService, type AppsOptions } from "./apps";
export type { AppsAdapter, AppsCommandResult } from "./apps-runtime";
export type {
  AppRecord,
  AppObservation,
  AppsPage,
  AppsCapabilities,
  AppManifest,
  AppCommand,
  AppCorner,
} from "../shared/apps";
