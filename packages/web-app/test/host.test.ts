import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { hostPage } from "../src/host.js";

it("executes the framework bridge without loading author code in the host", async () => {
  const handlers = new Map<string, (event?: unknown) => unknown>();
  const frameWindow = { postMessage: vi.fn() };
  const port = {
    postMessage: vi.fn(),
    close: vi.fn(),
    start: vi.fn(),
    onmessage: undefined as
      undefined | ((event: { data: unknown }) => Promise<void>),
  };
  const channel = { port1: port, port2: {} };
  const calls: { path: string; data: Record<string, unknown> }[] = [];
  let polling!: () => void;
  const pollEntered = new Promise<void>((resolve) => {
    polling = resolve;
  });
  const script = hostPage("secret").match(
    /<script[^>]*>([\s\S]*)<\/script>/,
  )![1]!;
  runInNewContext(script, {
    document: { querySelector: () => ({ contentWindow: frameWindow }) },
    window: {
      addEventListener: (
        name: string,
        handler: (event?: unknown) => unknown,
      ) => {
        handlers.set(name, handler);
      },
    },
    MessageChannel: function () {
      return channel;
    },
    async fetch(
      path: string,
      options: { headers: Record<string, string>; body: string },
    ) {
      expect(options.headers["X-IPAB-Web"]).toBe("secret");
      calls.push({
        path,
        data: JSON.parse(options.body) as Record<string, unknown>,
      });
      if (path === "/poll") {
        polling();
        return new Promise(() => {});
      }
      return {
        ok: true,
        json: () =>
          Promise.resolve(
            path === "/session"
              ? { session: "tab" }
              : { type: "result", id: "r1", value: "hello" },
          ),
      };
    },
  });
  const connect = handlers.get("message")!;
  await connect({ source: {}, origin: "null", data: "ipab:connect" });
  await connect({
    source: frameWindow,
    origin: "https://evil",
    data: "ipab:connect",
  });
  expect(calls).toEqual([]);
  void connect({ source: frameWindow, origin: "null", data: "ipab:connect" });
  await pollEntered;
  expect(frameWindow.postMessage).toHaveBeenCalledWith("ipab:port", "*", [
    channel.port2,
  ]);
  await port.onmessage!({
    data: {
      type: "call",
      id: "r1",
      method: "greet",
      input: "name",
      session: "forged",
    },
  });
  expect(calls.at(-1)).toEqual({
    path: "/call",
    data: {
      type: "call",
      id: "r1",
      method: "greet",
      input: "name",
      session: "tab",
    },
  });
  expect(port.postMessage).toHaveBeenCalledWith({
    type: "result",
    id: "r1",
    value: "hello",
  });
  await port.onmessage!({ data: { type: "cancel", id: "r1" } });
  expect(calls.at(-1)?.path).toBe("/cancel");
  await port.onmessage!({ data: { type: "close" } });
  expect(calls.at(-1)?.path).toBe("/disconnect");
  expect(port.close).toHaveBeenCalledOnce();
  handlers.get("pagehide")!();
  expect(port.close).toHaveBeenCalledOnce();
});
