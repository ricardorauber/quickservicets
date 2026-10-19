import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";

/** A sidebar group listing the pages of one folder. */
const group = (label, directory) => ({ label, items: [{ autogenerate: { directory } }] });

export default defineConfig({
  // The site only ships SVG images, which need no optimization.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "QuickService",
      description: "Backend services from TypeScript types, on Bun.",
      logo: { light: "./src/assets/logo-light.svg", dark: "./src/assets/logo-dark.svg", replacesTitle: true },
      customCss: ["./src/styles/theme.css"],
      sidebar: [
        group("Getting started", "getting-started"),
        group("Tutorial", "tutorial"),
        group("Guides", "guides"),
        group("Reference", "reference"),
        group("Recipes", "recipes"),
      ],
    }),
  ],
});
