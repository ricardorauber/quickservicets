import { describe, expect, test } from "bun:test";
import "./index.ts";
import { configureUploadChecks, hasUploadChecks, runUploadChecks } from "./upload-checks.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { memoryAdapter } from "./adapters/memory.ts";

/** A file whose content may not be read. */
class Untouchable extends Blob {
  override arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error("read");
  }
  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    throw new Error("read");
  }
}

describe("without checks", () => {
  test("uploads keep their single pass: nothing reads, copies or spools the file", async () => {
    configureUploadChecks({ checks: [], buffer: 1 });
    expect(hasUploadChecks()).toBe(false);
    await expect(runUploadChecks(new Untouchable(["x".repeat(100)]), { entity: "Media" })).resolves.toBeUndefined();
  });

  test("files.checkBuffer defaults to 8MB and QS_FILES_CHECK_BUFFER sets it; a check registered twice fails", () => {
    const files = (env: Record<string, string>) => resolveConfig({ database: memoryAdapter() } as ServiceConfig, env).files;
    expect(files({}).checkBuffer).toBe(8 * 1024 * 1024);
    expect(files({ QS_FILES_CHECK_BUFFER: "1MB" }).checkBuffer).toBe(1024 * 1024);
    expect(() => configureUploadChecks({ checks: [{ name: "a", check() {} }, { name: "a", check() {} }], buffer: 1 })).toThrow("Upload check a is registered twice");
    configureUploadChecks({ checks: [], buffer: 1 });
  });
});
