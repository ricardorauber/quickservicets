import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PUBLIC_PACKAGES, pinWorkspaceVersions, publishAll, SAMPLE_FILES, tarballProblems, tryInstall, type Manifest, type PackedPackage, type Runner } from "./release.ts";

const root = join(import.meta.dir, "..");
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest & Record<string, any>;

describe("manifests", () => {
  test.each(PUBLIC_PACKAGES)("%s declares what npm needs and ships no tests", (dir) => {
    const manifest = manifestOf(dir);
    expect(manifest.license).toBe("MIT");
    expect(manifest.description).toBeString();
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.keywords).toContain("quickservicets");
    expect(manifest.engines).toEqual({ bun: ">=1.4.2" });
    expect(manifest.publishConfig).toEqual({ access: "public" });
    expect(manifest.files).toEqual(expect.arrayContaining(["README.md", "LICENSE"]));
    expect(manifest.repository.url).toBe("git+https://github.com/ricardorauber/quickservicets.git");
    for (const file of ["README.md", "LICENSE"]) expect(existsSync(join(root, dir, file))).toBe(true);
  });

  test("core and cli ship their source without tests, fixtures or generated folders", () => {
    for (const dir of ["packages/core", "packages/cli"]) {
      expect(manifestOf(dir).files).toEqual(expect.arrayContaining(["src", "!src/**/*.test.ts", "!src/**/__snapshots__", "!src/**/fixtures", "!src/**/.generated"]));
    }
  });

  test("quickservicets has the same version, depends on the CLI and runs it as its bin", () => {
    const thin = manifestOf("packages/quickservicets");
    const cli = manifestOf("packages/cli");
    expect(thin.name).toBe("quickservicets");
    expect(thin.version).toBe(cli.version);
    expect(thin.dependencies).toEqual({ "@quickservicets/cli": "workspace:*" });
    expect(thin.bin).toEqual({ quickservicets: "bin/quickservicets.ts" });
    expect(readFileSync(join(root, "packages/quickservicets/bin/quickservicets.ts"), "utf8")).toContain('import "@quickservicets/cli/bin";');
    expect(cli.exports["./bin"]).toBe(cli.bin.quickservicets.replace(/^(?!\.\/)/, "./"));
  });
});

describe("tarball rules", () => {
  const manifest: Manifest = { name: "@quickservicets/cli", version: "0.1.0", bin: { quickservicets: "src/index.ts" }, dependencies: { "@quickservicets/core": "0.1.0" } };
  const good = ["package/package.json", "package/LICENSE", "package/README.md", "package/src/index.ts", "package/src/lib.ts", "package/.env.example"];

  test("a clean package has no problem", () => {
    expect(tarballProblems(good, manifest)).toEqual([]);
  });

  test("test files, .env files and paths outside the package are named", () => {
    const entries = [...good, "package/src/run.test.ts", "package/src/openapi/__snapshots__/doc.snap", "package/src/queue-test-support.ts", "package/.env", "package/config/.env.local", "other/file.ts", "package/../x.ts"];
    expect(tarballProblems(entries, manifest)).toEqual([
      "test file: src/run.test.ts",
      "test file: src/openapi/__snapshots__/doc.snap",
      "test file: src/queue-test-support.ts",
      ".env file: .env",
      ".env file: config/.env.local",
      "path outside the package: other/file.ts",
      "path outside the package: package/../x.ts",
    ]);
  });

  test("workspace dependencies and missing LICENSE, README.md or bin target are named", () => {
    const entries = ["package/package.json", "package/src/lib.ts"];
    const linked = { ...manifest, dependencies: { "@quickservicets/core": "workspace:*" } };
    expect(tarballProblems(entries, linked)).toEqual([
      "workspace dependency: @quickservicets/core@workspace:* in dependencies",
      "missing LICENSE",
      "missing README.md",
      "missing bin target: src/index.ts",
    ]);
  });
});

test("workspace: dependencies are pinned to the exact version of the package", () => {
  const versions = new Map([
    ["@quickservicets/core", "0.1.0"],
    ["@quickservicets/cli", "0.1.0"],
  ]);
  const manifest: Manifest = { name: "quickservicets", version: "0.1.0", dependencies: { "@quickservicets/cli": "workspace:*", typescript: "5.9.2" }, peerDependencies: { "@quickservicets/core": "workspace:^" } };
  expect(pinWorkspaceVersions(manifest, versions)).toEqual({
    name: "quickservicets",
    version: "0.1.0",
    dependencies: { "@quickservicets/cli": "0.1.0", typescript: "5.9.2" },
    peerDependencies: { "@quickservicets/core": "0.1.0" },
  });
  expect(() => pinWorkspaceVersions({ name: "x", version: "1.0.0", dependencies: { other: "workspace:*" } }, versions)).toThrow("no workspace package other");
});

describe("publishing", () => {
  const packed = ["@quickservicets/core", "@quickservicets/cli", "quickservicets"].map(
    (name) => ({ dir: "", tarball: `/tmp/${name.replace("@", "").replace("/", "-")}-0.1.0.tgz`, manifest: { name, version: "0.1.0" }, entries: [] }) satisfies PackedPackage,
  );
  const stubNpm = (failing?: string) => {
    const calls: string[][] = [];
    const run: Runner = async (command) => {
      calls.push(command);
      return command[2]!.includes(failing ?? "\0") ? { code: 1, output: "E403 forbidden" } : { code: 0, output: "" };
    };
    return { calls, run };
  };

  test("publishes core, then cli, then quickservicets with npm publish --access public", async () => {
    const npm = stubNpm();
    const lines: string[] = [];
    expect(await publishAll(packed, { run: npm.run, log: (line) => lines.push(line) })).toEqual({ published: ["@quickservicets/core", "@quickservicets/cli", "quickservicets"] });
    expect(npm.calls).toEqual(packed.map((entry) => ["npm", "publish", entry.tarball, "--access", "public"]));
    expect(lines).toEqual(["Published @quickservicets/core@0.1.0", "Published @quickservicets/cli@0.1.0", "Published quickservicets@0.1.0"]);
  });

  test("passes the one-time password when given", async () => {
    const npm = stubNpm();
    await publishAll(packed, { run: npm.run, otp: "123456" });
    expect(npm.calls.every((call) => call.slice(-2).join(" ") === "--otp 123456")).toBe(true);
  });

  test("stops at the first failure without publishing the rest", async () => {
    const npm = stubNpm("quickservicets-cli");
    expect(await publishAll(packed, { run: npm.run })).toEqual({ published: ["@quickservicets/core"], failed: "@quickservicets/cli", output: "E403 forbidden" });
    expect(npm.calls).toHaveLength(2);
  });
});

describe("the project created from the tarballs", () => {
  const packed = ["@quickservicets/core", "@quickservicets/cli", "quickservicets"].map(
    (name) => ({ dir: "", tarball: `/tmp/${name.replace("@", "").replace("/", "-")}-0.1.0.tgz`, manifest: { name, version: "0.1.0" }, entries: [] }) satisfies PackedPackage,
  );
  /** Plays init by writing the new project's manifest; fails the command whose label is given. */
  const stub = (failing?: string) => {
    const calls: { command: string; folder: string; sampleFiles: boolean; dependencies?: Record<string, string> }[] = [];
    const run: Runner = async (command, options = {}) => {
      const cwd = options.cwd!;
      if (command[1] === "init") {
        mkdirSync(join(cwd, "demo"), { recursive: true });
        writeFileSync(join(cwd, "demo/package.json"), JSON.stringify({ name: "demo", dependencies: { "@quickservicets/core": "^0.1.0", "@quickservicets/cli": "^0.1.0" } }));
      }
      const manifest = existsSync(join(cwd, "package.json")) ? JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) : {};
      const label = [basename(command[0]!), ...command.slice(1)].join(" ");
      calls.push({ command: label, folder: basename(cwd), sampleFiles: Object.keys(SAMPLE_FILES).every((file) => existsSync(join(cwd, file))), dependencies: manifest.dependencies });
      return label === failing ? { code: 2, output: "jobs/report.ts(4,9): error TS2304: Cannot find name 'Bun'." } : { code: 0, output: "" };
    };
    return { calls, run };
  };

  test("is installed from the tarballs, gets an entity, an endpoint, a pre-hook and a job, and is type-checked", async () => {
    expect(Object.keys(SAMPLE_FILES)).toEqual(expect.arrayContaining(["entities/Note.ts", "endpoints/notes/latest/get.ts", "hooks/authorized.ts", "jobs/report.ts"]));
    const { calls, run } = stub();
    expect(await tryInstall(packed, run)).toEqual([]);
    expect(calls.map((call) => call.command)).toEqual(["bun install", "quickservicets init demo --db memory", "bun install", "bun run build", "bun run typecheck"]);
    const [, , install, build, typecheck] = calls;
    expect(install!.folder).toBe("demo");
    expect(install!.dependencies).toEqual({ "@quickservicets/core": `file:${packed[0]!.tarball}`, "@quickservicets/cli": `file:${packed[1]!.tarball}` });
    expect([build!.folder, build!.sampleFiles, typecheck!.folder]).toEqual(["demo", true, "demo"]);
  });

  test("a type error fails the check with the compiler output", async () => {
    const problems = await tryInstall(packed, stub("bun run typecheck").run);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("bun run typecheck failed in ");
    expect(problems[0]).toContain("Cannot find name 'Bun'");
  });
});
