import { describe, expect, spyOn, test } from "bun:test";
import "./index.ts";
import { createServer, upgradeRequest } from "./http/server.ts";
import { defineSocket, isSocketDefinition, setSocketRunner, socketEndpoint } from "./http/socket.ts";
import { HttpError } from "./errors.ts";

describe("Bun's WebSocket handler", () => {
  test("a server without socket routes passes no websocket option to Bun.serve; one with them does", async () => {
    const serve = spyOn(Bun, "serve");
    try {
      const plain = createServer({ routes: [], repos: {}, config: { production: false } }).listen(0);
      expect((serve.mock.calls[0]![0] as unknown as Record<string, unknown>).websocket).toBeUndefined();
      await plain.stop(true);
      const websocket = { message() {} };
      const sockets = createServer({ routes: [], repos: {}, config: { production: false }, websocket }).listen(0);
      expect((serve.mock.calls[1]![0] as unknown as Record<string, unknown>).websocket).toBe(websocket);
      await sockets.stop(true);
    } finally {
      serve.mockRestore();
    }
  });

  test("a request no server accepted cannot be upgraded", () => {
    expect(upgradeRequest(new Request("http://localhost/x"), {})).toBe(false);
  });
});

describe("defineSocket", () => {
  test("it checks its handlers, and its route answers 404 while no runner serves sockets", async () => {
    const definition = defineSocket({ message: () => {} });
    expect(isSocketDefinition(definition)).toBe(true);
    expect(() => defineSocket({ message: "nope" } as never)).toThrow("defineSocket: message must be a function");
    setSocketRunner(undefined);
    let error: unknown;
    try {
      await socketEndpoint(definition)({}, {} as never, {} as never);
    } catch (thrown) {
      error = thrown;
    }
    expect((error as HttpError).status).toBe(404);
  });
});
