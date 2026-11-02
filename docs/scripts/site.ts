/**
 * Where the docs site lives: its source repository and its public URL. `astro.config.mjs` reads these; everything here
 * runs under Node and Bun alike.
 */

/** The GitHub repository of QuickService.ts. */
export const REPOSITORY_URL = "https://github.com/ricardorauber/quickservicets";

/** The base of the "Edit page" links: Starlight appends each page's source path inside the docs folder. */
export const EDIT_BASE_URL = `${REPOSITORY_URL}/edit/main/docs/`;

/**
 * The public URL of the site: `DOCS_SITE_URL` when it is set, otherwise `https://` plus Vercel's
 * `VERCEL_PROJECT_PRODUCTION_URL` when that is set, otherwise `undefined` (local builds need none).
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const explicit = env.DOCS_SITE_URL?.trim();
  if (explicit) return explicit;
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return undefined;
}
