import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The folder a bundle's assets were copied to, or undefined in a normal project run. */
let assetsRoot: string | undefined;
/** The files a compiled binary embeds, by their path inside the assets, before they are first read. */
let embedded: Readonly<Record<string, string>> | undefined;

/** Called by a bundle's entry: assets are read from this folder (`<bundle>/assets`) instead of the project. */
export function setAssetsRoot(dir: string | undefined): void {
  assetsRoot = dir;
  embedded = undefined;
}

/**
 * Called by a compiled binary's entry with the files it embeds, by their path inside the assets; they are written to a
 * temporary folder the first time an asset is asked for, so code reading folders works as in a project.
 */
export function setEmbeddedAssets(files: Readonly<Record<string, string>>): void {
  embedded = files;
  assetsRoot = undefined;
}

/** Writes the embedded files to a temporary folder once and makes it the assets folder. */
function extractEmbedded(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-assets-"));
  for (const [path, source] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
  return dir;
}

/**
 * The path of a file or folder read at runtime, like `migrations` or `.generated/openapi.json`: inside the assets of a
 * bundle or binary, and in the project (the working directory) otherwise.
 */
export function assetPath(name: string): string {
  if (embedded) {
    assetsRoot = extractEmbedded(embedded);
    embedded = undefined;
  }
  return join(assetsRoot ?? process.cwd(), name);
}

/** Whether the service runs from a bundle or binary with its own assets. */
export function bundledAssets(): boolean {
  return assetsRoot !== undefined || embedded !== undefined;
}
