import { describe, expect, spyOn, test } from "bun:test";
import "./index.ts";
import { defineSocket, withMessageValidator, type Socket } from "./http/socket.ts";
import { compileMessageValidator } from "./http/socket-messages.ts";
import { decodeFrame } from "./features/realtime/sockets.ts";

type In = { type: "say"; text: string } | { type: "typing" };
type Out = { type: "said"; text: string };

// Type-level checks: compiled by tsc, never run.
function types() {
  defineSocket<{ in: In; out: Out; data: { count: number } }>({
    on: {
      say: (ws, m) => {
        const text: string = m.text;
        ws.send({ type: "said", text });
        // @ts-expect-error the socket sends only its out type
        ws.send({ type: "nope" });
        const count: number = ws.data.count;
        return count;
      },
      typing: (_ws, m) => {
        // @ts-expect-error a typing message has no text
        return m.text;
      },
    },
  });
  defineSocket({
    message: (ws: Socket, data) => {
      const raw: string | Uint8Array = data;
      ws.send(raw);
    },
  });
  defineSocket<{ in: In; out: Out }>({
    message: (_ws, data) => {
      const typed: In = data;
      // @ts-expect-error a typed message is not a raw frame
      const raw: string = data;
      return [typed, raw];
    },
  });
}
void types;

const SCHEMA = {
  anyOf: [
    { type: "object", properties: { type: { type: "string", enum: ["say"] }, text: { type: "string" } }, required: ["type", "text"] },
    { type: "object", properties: { type: { type: "string", enum: ["typing"] } }, required: ["type"] },
  ],
};

const typed = (handlers: Parameters<typeof defineSocket>[0] | Record<string, unknown>) =>
  withMessageValidator(defineSocket(handlers as never), compileMessageValidator({ schema: SCHEMA }));

describe("validators", () => {
  test("a discriminated union gets one validator per type, and issues name their path", () => {
    const validator = compileMessageValidator({ schema: SCHEMA });
    expect([...validator.byType!.keys()]).toEqual(["say", "typing"]);
    expect(validator.byType!.get("say")!({ type: "say", text: "hi" })).toBeUndefined();
    expect(validator.byType!.get("say")!({ type: "say", text: 5 })).toEqual([{ path: "text", message: "Must be string, got number" }]);
    expect(validator.byType!.get("say")!({ type: "say" })).toEqual([{ path: "text", message: "Is required" }]);
    expect(validator.validate("x")).toEqual([{ path: "", message: "Must match one of the expected shapes" }]);
  });

  test("references to component schemas, arrays, nullable values and dates are checked", () => {
    const validator = compileMessageValidator({
      schema: { type: "object", properties: { post: { $ref: "#/components/schemas/Post" }, tags: { type: "array", items: { type: "string" } }, at: { type: ["string", "null"], format: "date-time" } }, required: ["post"] },
      definitions: { Post: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    });
    expect(validator.validate({ post: { title: "a" }, tags: ["x"], at: null })).toBeUndefined();
    expect(validator.validate({ post: {}, tags: [1], at: "nope" })).toEqual([
      { path: "post.title", message: "Is required" },
      { path: "tags.0", message: "Must be string, got number" },
      { path: "at", message: "Must be a date-time" },
    ]);
  });
});

describe("routing and errors", () => {
  test("invalid JSON, a wrong shape and binary frames answer INVALID_MESSAGE", () => {
    const definition = typed({ on: { say: () => {}, typing: () => {} } });
    expect(decodeFrame("not json", definition)).toEqual({ error: { code: "INVALID_MESSAGE", message: "Message is not valid JSON" } });
    expect(decodeFrame('{"type":"say","text":5}', definition)).toEqual({
      error: { code: "INVALID_MESSAGE", message: "Message does not match the expected shape", details: [{ path: "text", message: "Must be string, got number" }] },
    });
    expect(decodeFrame(new Uint8Array([1]), definition)).toEqual({ error: { code: "INVALID_MESSAGE", message: "Binary messages are not accepted" } });
  });

  test("messages are routed by type; an unknown type goes to message, or answers UNKNOWN_MESSAGE_TYPE", () => {
    const say = () => "said";
    const fallback = () => "fallback";
    const routed = decodeFrame('{"id":7,"type":"say","text":"hi"}', typed({ on: { say } }));
    expect(routed).toMatchObject({ handler: say, value: { type: "say", text: "hi" }, id: 7 });
    expect(decodeFrame('{"type":"dance"}', typed({ on: { say } }))).toEqual({ error: { code: "UNKNOWN_MESSAGE_TYPE", message: "Unknown message type dance" } });
    expect(decodeFrame('{"type":"dance"}', typed({ on: { say }, message: fallback }))).toMatchObject({ handler: fallback, value: { type: "dance" } });
    expect(decodeFrame('{"type":"typing"}', typed({ on: { say }, message: fallback }))).toMatchObject({ handler: fallback });
  });
});

describe("cost", () => {
  test("100,000 valid frames take one JSON parse and one validator call each", () => {
    const validator = compileMessageValidator({ schema: SCHEMA });
    let calls = 0;
    const say = validator.byType!.get("say")!;
    const counted = { ...validator, byType: new Map([...validator.byType!].map(([type, fn]) => [type, type === "say" ? (value: unknown) => ((calls += 1), say(value)) : fn])) };
    const definition = withMessageValidator(defineSocket({ on: { say: () => {} } } as never), counted);
    const parse = spyOn(JSON, "parse");
    try {
      const frame = '{"type":"say","text":"hi"}';
      for (let index = 0; index < 100_000; index++) {
        const decoded = decodeFrame(frame, definition);
        if ("error" in decoded) throw new Error("unexpected error frame");
      }
      expect(parse).toHaveBeenCalledTimes(100_000);
      expect(calls).toBe(100_000);
    } finally {
      parse.mockRestore();
    }
  });
});
