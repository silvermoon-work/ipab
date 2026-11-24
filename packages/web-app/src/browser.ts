import {
  errorReply,
  json,
  name,
  object,
  type BackendEvent,
  type JsonValue,
} from "./protocol.js";

export interface WebAppConnection {
  request(
    method: string,
    input: JsonValue,
    options?: { signal?: AbortSignal },
  ): Promise<JsonValue>;
  onEvent(listener: (event: BackendEvent) => void): () => void;
  close(): void;
}

export function connectWebApp(
  options: { signal?: AbortSignal } = {},
): Promise<WebAppConnection> {
  return new Promise((resolve, reject) => {
    let connected = false;
    const fail = () => {
      window.removeEventListener("message", receive);
      options.signal?.removeEventListener("abort", fail);
      clearTimeout(timer);
      reject(new DOMException("Connection cancelled", "AbortError"));
    };
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || connected) return;
      if (event.data !== "ipab:port" || event.ports.length !== 1) return;
      connected = true;
      window.removeEventListener("message", receive);
      options.signal?.removeEventListener("abort", fail);
      clearTimeout(timer);
      const port = event.ports[0]!;
      resolve(connection(port));
    };
    const timer = setTimeout(fail, 10_000);
    window.addEventListener("message", receive);
    options.signal?.addEventListener("abort", fail, { once: true });
    if (options.signal?.aborted) {
      fail();
      return;
    }
    window.parent.postMessage("ipab:connect", "*");
  });
}

function connection(port: MessagePort): WebAppConnection {
  let sequence = 0;
  let closed = false;
  const pending = new Map<
    string,
    {
      resolve: (value: JsonValue) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  const listeners = new Set<(event: BackendEvent) => void>();
  const close = () => {
    if (closed) return;
    closed = true;
    port.postMessage({ type: "close" });
    port.close();
    for (const call of pending.values()) {
      call.cleanup();
      call.reject(new Error("Connection closed"));
    }
    pending.clear();
    listeners.clear();
  };
  port.onmessage = (event: MessageEvent<unknown>) => {
    try {
      const message = object(event.data);
      if (message.type === "event") {
        const notification = {
          name: name(message.name),
          data: json(message.data),
        };
        for (const listener of listeners) listener(notification);
        return;
      }
      if (message.type === "closed") {
        close();
        return;
      }
      const id = name(message.id);
      const call = pending.get(id);
      if (!call) return;
      if (message.type !== "result" && message.type !== "error")
        throw new Error("Invalid response");
      const failure =
        message.type === "error" ? object(message.error) : undefined;
      if (failure) {
        name(failure.code);
        if (typeof failure.message !== "string" || failure.message.length > 256)
          throw new Error("Invalid error");
      }
      pending.delete(id);
      call.cleanup();
      if (failure) call.reject(new Error(failure.message as string));
      else call.resolve(json(message.value));
    } catch {
      close();
    }
  };
  port.onmessageerror = close;
  port.start();
  return {
    request(method, input, options = {}) {
      if (closed) return Promise.reject(new Error("Connection closed"));
      if (pending.size >= 32)
        return Promise.reject(new Error("Too many pending requests"));
      name(method);
      json(input);
      return new Promise((resolve, reject) => {
        const id = `r${++sequence}`;
        const abort = () => {
          pending.delete(id);
          options.signal?.removeEventListener("abort", abort);
          port.postMessage({ type: "cancel", id });
          reject(new DOMException("Request cancelled", "AbortError"));
        };
        if (options.signal?.aborted) {
          reject(new DOMException("Request cancelled", "AbortError"));
          return;
        }
        pending.set(id, {
          resolve,
          reject,
          cleanup: () => options.signal?.removeEventListener("abort", abort),
        });
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          port.postMessage(json({ type: "call", id, method, input }));
        } catch {
          port.onmessage?.(
            new MessageEvent("message", {
              data: errorReply(id, "TransportError"),
            }),
          );
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
  };
}
