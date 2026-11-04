/**
 * Removes the test containers of a process once it is gone: `bun test` runs no exit handlers, so `startServices`
 * starts this script beside the test process. It waits for the process to end, then runs `docker compose down` for
 * every project still listed in the state file, one JSON line `{ project, file, dir }` each.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";

const [parent, stateFile] = process.argv.slice(2);
// Ctrl-C reaches the whole process group; this script outlives the test process to clean up after it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});

const alive = () => {
  try {
    process.kill(Number(parent), 0);
    return true;
  } catch {
    return false;
  }
};
while (alive()) await Bun.sleep(500);
if (stateFile && existsSync(stateFile)) {
  for (const line of readFileSync(stateFile, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const { project, file, dir } = JSON.parse(line) as { project: string; file: string; dir: string };
    if (!existsSync(file)) continue;
    Bun.spawnSync(["docker", "compose", "-f", file, "-p", project, "down", "--volumes", "--timeout", "1"], { stdout: "ignore", stderr: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(stateFile, { force: true });
}
process.exit(0);
