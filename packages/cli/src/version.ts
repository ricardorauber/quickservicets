import packageJson from "../package.json" with { type: "json" };

export const version: string = packageJson.version;

/** The product name people read. */
export const PRODUCT_NAME = "QuickService.ts";

/** The first line of `--version` and of the general help, like `QuickService.ts 0.1.0`. */
export const versionHeader = `${PRODUCT_NAME} ${version}`;
