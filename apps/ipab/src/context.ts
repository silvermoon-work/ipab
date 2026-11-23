import { HostError } from "./errors.js";
import { CHUNK_BYTES, relativePath } from "./space.js";

export interface AppContext {
  readonly appCid: string;
  readFile(
    rootCid: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
  output: {
    writeFile(
      path: string,
      stream: ReadableStream<Uint8Array>,
      options?: { signal?: AbortSignal },
    ): Promise<string>;
    link(
      path: string,
      unixfsCid: string,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  };
}
export interface Request {
  version: 1;
  id: number;
  operation: string;
  args: unknown;
}
export interface Reply {
  version: 1;
  id: number;
  result?: unknown;
  error?: string;
}
export interface Port {
  send(frame: Request | Reply, callback: (error: Error | null) => void): void;
  on(event: "message", listener: (frame: unknown) => void): void;
  on(event: "disconnect", listener: () => void): void;
  off(event: "message", listener: (frame: unknown) => void): void;
  off(event: "disconnect", listener: () => void): void;
  ref?(): void;
  unref?(): void;
}
export function requestFrame(value: unknown): value is Request {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<Request>;
  return (
    frame.version === 1 &&
    Number.isSafeInteger(frame.id) &&
    Number(frame.id) > 0 &&
    typeof frame.operation === "string" &&
    frame.operation.length <= 32
  );
}

export function createContext(port: Port): {
  context: AppContext;
  initialize: () => Promise<void>;
  close: () => void;
} {
  let sequence = 0;
  let appCid: string | undefined;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const close = () => {
    for (const entry of pending.values())
      entry.reject(new HostError("IPAB context channel disconnected."));
    pending.clear();
    port.off("message", receive);
    port.off("disconnect", close);
    port.unref?.();
  };
  const receive = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const frame = value as {
      version?: unknown;
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    if (frame.version !== 1 || !Number.isSafeInteger(frame.id)) return;
    const entry = pending.get(frame.id!);
    if (!entry) return;
    pending.delete(frame.id!);
    if (!pending.size) port.unref?.();
    if (typeof frame.error === "string")
      entry.reject(new HostError(frame.error));
    else entry.resolve(frame.result);
  };
  port.on("message", receive);
  port.on("disconnect", close);
  port.unref?.();
  const rpc = async (
    operation: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    signal?.throwIfAborted();
    if (pending.size >= 32)
      throw new HostError("IPAB context request capacity exceeded.");
    const id = ++sequence;
    port.ref?.();
    const cancellation = () => {
      port.send(
        { version: 1, id: ++sequence, operation: "cancel", args: id },
        () => {},
      );
    };
    signal?.addEventListener("abort", cancellation, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.send({ version: 1, id, operation, args }, (error) => {
          if (error) {
            pending.delete(id);
            if (!pending.size) port.unref?.();
            reject(error);
          }
        });
      });
    } finally {
      signal?.removeEventListener("abort", cancellation);
    }
  };
  const context: AppContext = {
    get appCid() {
      if (!appCid)
        throw new HostError("IPAB context identity is not initialized.");
      return appCid;
    },
    async readFile(rootCid, path, options = {}) {
      relativePath(path);
      const id = (await rpc(
        "read",
        { rootCid, path },
        options.signal,
      )) as number;
      if (options.signal?.aborted) {
        await rpc("readCancel", id).catch(() => {});
        options.signal.throwIfAborted();
      }
      const abort = () => {
        void rpc("readCancel", id).catch(() => {});
      };
      const finished = () => {
        options.signal?.removeEventListener("abort", abort);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const value = (await rpc(
                "pull",
                id,
                options.signal,
              )) as Uint8Array | null;
              if (value === null) {
                finished();
                controller.close();
              } else controller.enqueue(value);
            } catch (error) {
              finished();
              controller.error(error);
              await rpc("readCancel", id).catch(() => {});
            }
          },
          async cancel() {
            finished();
            await rpc("readCancel", id);
          },
        },
        { highWaterMark: 0 },
      );
    },
    output: {
      async writeFile(path, stream, options = {}) {
        relativePath(path);
        const id = (await rpc("write", { path }, options.signal)) as number;
        const reader = stream.getReader();
        const abort = () => {
          void reader.cancel(options.signal?.reason).catch(() => {});
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          for (;;) {
            options.signal?.throwIfAborted();
            const item = await reader.read();
            if (item.done) break;
            if (!(item.value instanceof Uint8Array))
              throw new HostError("Output stream must contain bytes.");
            for (
              let offset = 0;
              offset < item.value.length;
              offset += CHUNK_BYTES
            )
              await rpc(
                "chunk",
                { id, bytes: item.value.slice(offset, offset + CHUNK_BYTES) },
                options.signal,
              );
          }
          return (await rpc("end", id, options.signal)) as string;
        } catch (error) {
          await reader.cancel(error);
          await rpc("writeCancel", id).catch(() => {});
          throw error;
        } finally {
          options.signal?.removeEventListener("abort", abort);
          reader.releaseLock();
        }
      },
      async link(path, unixfsCid, options = {}) {
        relativePath(path);
        await rpc("link", { path, rootCid: unixfsCid }, options.signal);
      },
    },
  };
  return {
    context,
    close,
    async initialize() {
      const value = await rpc("identity", null);
      if (typeof value !== "string" || !value)
        throw new HostError("Invalid IPAB context identity.");
      appCid = value;
    },
  };
}
