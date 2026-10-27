import type { ServerSettings } from "./http/server.ts";

/** The feature whose setup runs now, with the server settings of its service; the lifecycle sets it around each setup. */
export interface ActiveSetup {
  /** The key of the feature whose setup runs. */
  feature: string;
  /** The server settings of the service being set up, which the core's setup-only functions fill. */
  server: ServerSettings;
}

let active: ActiveSetup | undefined;

/** Marks the start (a value) or the end (undefined) of a feature's setup. */
export function setActiveSetup(setup: ActiveSetup | undefined): void {
  active = setup;
}

/** The setup running now, or undefined outside feature setups. */
export function activeSetup(): ActiveSetup | undefined {
  return active;
}
