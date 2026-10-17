import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";

/** A sidebar group listing the pages of one folder, with its Portuguese label. */
const group = (label, portuguese, directory) => ({ label, translations: { "pt-BR": portuguese }, items: [{ autogenerate: { directory } }] });

export default defineConfig({
  // The site only ships SVG images, which need no optimization.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "quickservice",
      description: "Backend services from TypeScript types, on Bun.",
      logo: { light: "./src/assets/logo-light.svg", dark: "./src/assets/logo-dark.svg", replacesTitle: true },
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        "pt-br": { label: "Português (Brasil)", lang: "pt-BR" },
      },
      customCss: ["./src/styles/theme.css"],
      sidebar: [
        group("Getting started", "Primeiros passos", "getting-started"),
        group("Tutorial", "Tutorial", "tutorial"),
        group("Guides", "Guias", "guides"),
        group("Reference", "Referência", "reference"),
        group("Recipes", "Receitas", "recipes"),
      ],
    }),
  ],
});
