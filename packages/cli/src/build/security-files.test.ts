import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "@quickservice/cli/testing";
import { contentDisposition } from "@quickservice/core";
import { FILE_CSP } from "../../../core/src/features/security/files.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = (security = "") => {
  const dir = mkdtempSync(join(tmpdir(), "quickservice-files-"));
  dirs.push(dir);
  return `import { defineConfig, localStorage, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), storage: { default: localStorage({ dir: ${JSON.stringify(dir)} }) }, files: { signingSecret: "test-secret" }${security ? `, security: ${security}` : ""} });
`;
};
const ENTITIES = {
  "entities/Document.ts": 'import type { File } from "@quickservice/core";\n/** @access proxy */\nexport type Document = File & { title?: string };\n',
  "entities/Contract.ts": 'import type { File } from "@quickservice/core";\n/** @access signed 60 */\nexport type Contract = File & { party?: string };\n',
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

async function withService(security: string, run: (service: TestService) => Promise<void>): Promise<void> {
  const service = await startTestService({ files: { "quickservice.config.ts": CONFIG(security), ...ENTITIES } });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}

/** Uploads a file and returns the response of its file route. */
async function served(service: TestService, collection: string, name: string, type: string, content: string | Uint8Array = "<p>hi</p>"): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([content], name, { type }));
  const created = await service.fetch(`/${collection}`, { method: "POST", body: form });
  expect(created.status).toBe(201);
  const record = (await created.json()) as { id: string; url: string };
  return service.fetch(collection === "documents" ? `/documents/${record.id}/file` : record.url);
}

const fileHeaders = (response: Response) => ({
  "x-content-type-options": response.headers.get("x-content-type-options"),
  "content-disposition": response.headers.get("content-disposition"),
  "content-security-policy": response.headers.get("content-security-policy"),
});

describe("headers on file routes", () => {
  test("proxy and signed routes send nosniff, an inline disposition and the sandbox policy, also without the headers item", async () => {
    for (const security of ["", "{ headers: false }"]) {
      await withService(security, async (service) => {
        for (const collection of ["documents", "contracts"]) {
          const response = await served(service, collection, "photo.png", "image/png", PNG);
          expect(response.status).toBe(200);
          expect(fileHeaders(response)).toEqual({ "x-content-type-options": "nosniff", "content-disposition": 'inline; filename="photo.png"', "content-security-policy": FILE_CSP });
        }
      });
    }
  });
});

describe("attachments", () => {
  test("SVG and HTML files are attachments, a PDF stays inline, with the sanitized name", async () => {
    await withService("", async (service) => {
      expect((await served(service, "documents", "logo.svg", "image/svg+xml", "<svg/>")).headers.get("content-disposition")).toBe('attachment; filename="logo.svg"');
      expect((await served(service, "documents", "page.html", "text/html")).headers.get("content-disposition")).toBe('attachment; filename="page.html"');
      expect((await served(service, "documents", "report.pdf", "application/pdf", "%PDF-1.4")).headers.get("content-disposition")).toBe('inline; filename="report.pdf"');
      // The upload stores the name as the form sent it; both dispositions sanitize it the same way.
      const quoted = await served(service, "documents", 'a"b.svg', "image/svg+xml", "<svg/>");
      expect(quoted.headers.get("content-disposition")).toBe('attachment; filename="a%22b.svg"');
      expect(contentDisposition('a"b\\c\r\n.svg', "attachment")).toBe(contentDisposition('a"b\\c\r\n.svg').replace("inline", "attachment"));
      expect(contentDisposition('a"b.svg', "attachment")).toBe('attachment; filename="ab.svg"');
    });
  });

  test("attachmentTypes replaces the list", async () => {
    await withService('{ files: { attachmentTypes: ["application/pdf"] } }', async (service) => {
      expect((await served(service, "documents", "report.pdf", "application/pdf", "%PDF-1.4")).headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
      expect((await served(service, "documents", "logo.svg", "image/svg+xml", "<svg/>")).headers.get("content-disposition")).toBe('inline; filename="logo.svg"');
    });
  });
});

describe("disabled item", () => {
  test("with files: false, file routes answer with the plain file headers", async () => {
    await withService("{ files: false, headers: false }", async (service) => {
      for (const collection of ["documents", "contracts"]) {
        const response = await served(service, collection, "logo.svg", "image/svg+xml", "<svg/>");
        expect(response.status).toBe(200);
        expect(fileHeaders(response)).toEqual({ "x-content-type-options": null, "content-disposition": 'inline; filename="logo.svg"', "content-security-policy": null });
        expect(response.headers.get("content-type")).toBe("image/svg+xml");
        expect(response.headers.get("content-length")).toBe("6");
      }
    });
  });
});
