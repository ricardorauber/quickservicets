import { describe, expect, test } from "bun:test";
import { HttpError, codeForStatus, toErrorResponse } from "./errors.ts";

interface Body {
  error: { code: string; message: string; details?: { stack?: string } };
}

describe("status to code mapping", () => {
  test.each([
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [405, "METHOD_NOT_ALLOWED"],
    [409, "CONFLICT"],
    [413, "PAYLOAD_TOO_LARGE"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
    [500, "INTERNAL_ERROR"],
    [418, "HTTP_418"],
  ])("%d maps to %s", (status, code) => {
    expect(codeForStatus(status)).toBe(code);
    expect(new HttpError(status, "x").code).toBe(code);
  });
});

test("a custom code wins over the derived code", () => {
  expect(new HttpError(404, "x", { code: "USER_MISSING" }).code).toBe("USER_MISSING");
});

test("serialization omits details when undefined and sets the JSON content type", async () => {
  const response = toErrorResponse(new HttpError(404, "User not found"), { production: true });
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "User not found" } });
});

test("validation details are kept verbatim", async () => {
  const details = [{ field: "email", message: "Invalid email" }];
  const response = toErrorResponse(new HttpError(400, "Invalid body", { details }), { production: true });
  expect(await response.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "Invalid body", details } });
});

test("non-HttpError in production hides message and stack", async () => {
  const response = toErrorResponse(new Error("db password leaked"), { production: true });
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  expect(text).not.toContain("db password leaked");
});

test("non-HttpError in development includes the stack", async () => {
  const error = new Error("boom");
  const body = (await toErrorResponse(error, { production: false }).json()) as Body;
  expect(body.error.message).toBe("Internal server error");
  expect(body.error.details).toEqual({ stack: error.stack });
});

test.each<[unknown]>([["a string"], [undefined]])("thrown non-Error value %p becomes 500", async (value) => {
  const response = toErrorResponse(value, { production: true });
  expect(response.status).toBe(500);
  expect(((await response.json()) as Body).error.code).toBe("INTERNAL_ERROR");
});
