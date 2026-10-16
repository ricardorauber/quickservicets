import { describe, expect, test } from "bun:test";
import type { StorageAdapter } from "../storage/storage.ts";

const text = async (stream: ReadableStream<Uint8Array> | null) => (stream ? new Response(stream).text() : null);

/** Registers the behavior every `StorageAdapter` must have. The factory returns an empty storage. */
export function runStorageContract(name: string, factory: () => StorageAdapter | Promise<StorageAdapter>): void {
  describe(`${name} storage contract`, () => {
    test("round-trips bytes", async () => {
      const storage = await factory();
      await storage.put("media/1/a.txt", "hello", { contentType: "text/plain", size: 5 });
      expect(await text(await storage.get("media/1/a.txt"))).toBe("hello");
      const bytes = new Uint8Array([1, 2, 3]);
      await storage.put("media/1/b.bin", new Response(bytes).body!, { contentType: "application/octet-stream", size: 3 });
      expect(new Uint8Array(await new Response(await storage.get("media/1/b.bin")).arrayBuffer())).toEqual(bytes);
    });
    test("missing keys return null", async () => {
      expect(await (await factory()).get("media/none/x.png")).toBeNull();
    });
    test("delete is idempotent", async () => {
      const storage = await factory();
      await storage.put("files/1/a.txt", "x", { contentType: "text/plain", size: 1 });
      await storage.delete("files/1/a.txt");
      await storage.delete("files/1/a.txt");
      expect(await storage.get("files/1/a.txt")).toBeNull();
    });
    test.each(["/etc/passwd", "../outside.txt", "media/../../x", "media/./x", ""])("rejects unsafe key %p", async (key) => {
      const storage = await factory();
      await expect(storage.put(key, "x", { contentType: "text/plain", size: 1 })).rejects.toThrow("Invalid storage key");
    });
  });
}
