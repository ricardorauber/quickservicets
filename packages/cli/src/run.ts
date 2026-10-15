import { version } from "./version.ts";

export function run(args: string[], write: (line: string) => void = console.log): number {
  if (args.includes("--version")) {
    write(version);
  }
  return 0;
}
