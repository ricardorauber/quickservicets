/**
 * The type-checking tools `init` adds to a new project's `devDependencies`, at the exact versions the QuickService.ts
 * repository uses in its root `package.json`. A test keeps the two in step.
 */
export const TOOLCHAIN: Readonly<Record<"@types/bun" | "typescript", string>> = {
  "@types/bun": "1.4.2",
  typescript: "5.9.2",
};
