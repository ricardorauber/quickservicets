import starlight from "@astrojs/starlight";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, passthroughImageService } from "astro/config";
import { llmsFiles } from "./scripts/llms.ts";

/** Writes `llms.txt`, `llms-full.txt`, `llms-small.txt` and the Markdown copy of every page and agent topic into the built site. */
const llms = {
  name: "quickservicets-llms",
  hooks: {
    "astro:build:done": ({ dir, logger }) => {
      const root = fileURLToPath(dir);
      const files = llmsFiles();
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      logger.info(`Wrote llms.txt, llms-full.txt, llms-small.txt and ${Object.keys(files).length - 3} Markdown pages`);
    },
  },
};

/** A sidebar group listing the pages of one folder. */
const group = (label, directory) => ({ label, items: [{ autogenerate: { directory } }] });

export default defineConfig({
  // The site only ships SVG images, which need no optimization.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "QuickService.ts",
      description: "Backend services from TypeScript types, on Bun.",
      logo: { light: "./src/assets/logo-light.svg", dark: "./src/assets/logo-dark.svg", replacesTitle: true },
      customCss: ["./src/styles/theme.css"],
      components: { Footer: "./src/components/Footer.astro" },
      sidebar: [
        group("Getting started", "getting-started"),
        group("Tutorial", "tutorial"),
        group("Guides", "guides"),
        group("Reference", "reference"),
        group("Recipes", "recipes"),
      ],
    }),
    llms,
  ],
});
