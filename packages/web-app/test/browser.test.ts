import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWebApp } from "../src/browser.js";

class Port {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: unknown[] = [];
  closed = false;
  fail = false;
  postMessage(message: unknown) {
    if (this.fail) {
      this.fail = false;
      throw new Error("Transport error");
    }
    this.messages.push(message);
  }
  start() {}
  close() {
    this.closed = true;
  }
  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const parent = { postMessage: vi.fn() };
let receive: ((event: MessageEvent<unknown>) => void) | undefined;
const remove = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  receive = undefined;
  vi.stubGlobal("window", {
    parent,
    addEventListener(
      _type: string,
      listener: (event: MessageEvent<unknown>) => void,
    ) {
      receive = listener;
    },
    removeEventListener: remove,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function handshake(
  port: Port,
  source: unknown = parent,
  data: unknown = "ipab:port",
  ports?: Port[],
) {
  receive?.({
    source,
    data,
    ports: ports ?? [port],
  } as unknown as MessageEvent<unknown>);
}
async function connected() {
  const promise = connectWebApp();
  const port = new Port();
  handshake(port);
  return { client: await promise, port };
}

describe("browser port client", { tags: ["mock"] }, () => {
  it("accepts only the parent handshake and cleans up cancellation and timeout", async () => {
    const port = new Port();
    const promise = connectWebApp();
    handshake(port, {});
    handshake(port, parent, "wrong");
    handshake(port, parent, "ipab:port", []);
    expect(remove).not.toHaveBeenCalled();
    handshake(port);
    handshake(new Port());
    const client = await promise;
    expect(parent.postMessage).toHaveBeenCalledWith("ipab:connect", "*");
    client.close();
    const controller = new AbortController();
    const cancelled = connectWebApp({ signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      connectWebApp({ signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const timeout = connectWebApp();
    const result = expect(timeout).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(10000);
    await result;
  });

  it("routes results, fixed errors and notifications and detaches listeners", async () => {
    const { client, port } = await connected();
    const listener = vi.fn();
    const off = client.onEvent(listener);
    port.receive({ type: "event", name: "greet", data: { count: 1 } });
    expect(listener).toHaveBeenCalledWith({
      name: "greet",
      data: { count: 1 },
    });
    off();
    port.receive({ type: "event", name: "greet", data: null });
    expect(listener).toHaveBeenCalledTimes(1);
    const response = client.request("echo", "hello");
    expect(port.messages[0]).toEqual({
      type: "call",
      id: "r1",
      method: "echo",
      input: "hello",
    });
    port.receive({ type: "result", id: "unknown", value: 1 });
    port.receive({ type: "result", id: "r1", value: "world" });
    await expect(response).resolves.toBe("world");
    const failed = client.request("echo", null);
    port.receive({
      type: "error",
      id: "r2",
      error: { code: "MethodFailed", message: "MethodFailed" },
    });
    await expect(failed).rejects.toThrow("MethodFailed");
    client.close();
    client.close();
    expect(port.closed).toBe(true);
    await expect(client.request("echo", null)).rejects.toThrow("closed");
  });

  it("propagates request abort and rejects pending calls on close", async () => {
    const { client, port } = await connected();
    const signal = new AbortController();
    const response = client.request("echo", null, { signal: signal.signal });
    signal.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    expect(port.messages.at(-1)).toEqual({ type: "cancel", id: "r1" });
    await expect(
      client.request("echo", null, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const pending = client.request("echo", null);
    port.receive({ type: "closed" });
    await expect(pending).rejects.toThrow("Connection closed");
  });

  it("bounds outstanding calls and validates input before sending", async () => {
    const { client } = await connected();
    expect(() => client.request("invalid name", null)).toThrow("Invalid name");
    expect(() => client.request("echo", Infinity)).toThrow("plain JSON");
    const pending = Array.from({ length: 32 }, () =>
      client.request("echo", null).catch(() => {}),
    );
    await expect(client.request("echo", null)).rejects.toThrow("Too many");
    client.close();
    await Promise.all(pending);
  });

  it.each([
    { type: "bad", id: "r1" },
    { type: "result", id: "bad id", value: 1 },
    { type: "error", id: "r1", error: { code: "bad code", message: "x" } },
    { type: "error", id: "r1", error: { code: "Error", message: 1 } },
    {
      type: "error",
      id: "r1",
      error: { code: "Error", message: "x".repeat(257) },
    },
    { type: "event", name: "bad name", data: null },
  ])("closes on malformed response $type", async (data) => {
    const { client, port } = await connected();
    const pending = client.request("echo", null);
    port.receive(data);
    await expect(pending).rejects.toThrow("Connection closed");
  });

  it("handles message decoding and outbound transport failures", async () => {
    const { client, port } = await connected();
    port.fail = true;
    await expect(client.request("echo", null)).rejects.toThrow(
      "TransportError",
    );
    const pending = client.request("echo", null);
    port.onmessageerror?.();
    await expect(pending).rejects.toThrow("closed");
  });
});
