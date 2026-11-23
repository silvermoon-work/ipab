import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  createContext,
  requestFrame,
  type Port,
  type Reply,
  type Request,
} from "../src/context.js";
import { ContextServer } from "../src/ipc.js";
import { Ownership } from "../src/history.js";
import {
  appSchemaBlock,
  bytes,
  CHUNK_BYTES,
  OutputSpace,
} from "../src/space.js";
import { State } from "../src/state.js";
import { fixture, importFiles } from "./helpers.js";

class Transport extends EventEmitter {
  connected = true;
  readonly client = new EventEmitter();
  readonly ref = vi.fn();
  readonly unref = vi.fn();
  failSend: Error | null = null;
  send(frame: Reply, callback: (error: Error | null) => void): void {
    queueMicrotask(() => {
      this.client.emit("message", frame);
      callback(this.failSend);
    });
  }
  port(): Port {
    return {
      send: (frame, callback) => {
        queueMicrotask(() => {
          this.emit("message", frame);
          callback(null);
        });
      },
      on: (event, listener) => {
        this.client.on(event, listener);
      },
      off: (event, listener) => {
        this.client.off(event, listener);
      },
      ref: this.ref,
      unref: this.unref,
    };
  }
}

describe("bounded IPC streams on real writable Store", () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  let state: State;
  let owner: Ownership;
  let output: OutputSpace;
  let transport: Transport;
  let server: ContextServer;
  let client: ReturnType<typeof createContext>;
  let fatal: ReturnType<typeof vi.fn<(error: Error) => void>>;
  beforeEach(async () => {
    work = await fixture();
    state = new State(work.stateDir);
    owner = await Ownership.create(state, work.store, "ipc", "ipc-stage");
    output = new OutputSpace(work.store, owner, "ipc-stage");
    transport = new Transport();
    fatal = vi.fn();
    server = new ContextServer(
      transport as unknown as ChildProcess,
      work.store,
      owner,
      output,
      fatal,
      appSchemaBlock.cid.toString(),
    );
    client = createContext(transport.port());
  });
  afterEach(async () => {
    client.close();
    await server.close();
    await owner.release();
    state.close();
    await work.cleanup();
    vi.restoreAllMocks();
  });

  async function raw(
    transport: Transport,
    id: number,
    operation: string,
    args: unknown,
  ): Promise<Reply> {
    return new Promise((resolve) => {
      const listener = (reply: Reply) => {
        if (reply.id === id) {
          transport.client.off("message", listener);
          resolve(reply);
        }
      };
      transport.client.on("message", listener);
      transport.emit("message", {
        version: 1,
        id,
        operation,
        args,
      } satisfies Request);
    });
  }

  it("supports read backpressure, streamed writes and UnixFS links without Bundle validation", async () => {
    expect(() => client.context.appCid).toThrow("not initialized");
    await client.initialize();
    expect(client.context.appCid).toBe(appSchemaBlock.cid.toString());
    const source = await importFiles(work.store, {
      "nested/file": new Uint8Array(CHUNK_BYTES * 3).fill(3),
    });
    const file = (
      await work.store.read(`${source}/nested/file`)
    ).cid.toString();
    const stream = await client.context.readFile(source, "nested/file");
    const cid = await client.context.output.writeFile("copy", stream);
    expect(cid).toBe(file);
    await client.context.output.link("tree", source);
    await client.context.output.link("file", file);
    const root = await output.finalize();
    expect((await work.store.read(`${root}/copy`)).cid.toString()).toBe(file);
    expect((await work.store.read(`${root}/tree`)).cid.toString()).toBe(source);
    expect(fatal).not.toHaveBeenCalled();
    expect(transport.ref).toHaveBeenCalled();
    expect(transport.unref).toHaveBeenCalled();
  }, 20000);

  it("read cancel and explicit signals close resources; reads cannot escape the directory-relative Space", async () => {
    const source = await importFiles(work.store, { "dir/file": "value" });
    await expect(client.context.readFile(source, "../outside")).rejects.toThrow(
      "Unsafe",
    );
    await expect(client.context.readFile(source, "dir")).rejects.toThrow(
      "regular UnixFS file",
    );
    const file = (await work.store.read(`${source}/dir/file`)).cid.toString();
    await expect(client.context.readFile(file, "file")).rejects.toThrow(
      "Space root",
    );
    await expect(client.context.readFile(source, "missing")).rejects.toThrow();
    const stream = await client.context.readFile(source, "dir/file");
    await stream.cancel();
    const controller = new AbortController();
    const cancelled = await client.context.readFile(source, "dir/file", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(bytes(cancelled, 100)).rejects.toThrow();
    const early = new AbortController();
    early.abort(new Error("early abort"));
    await expect(
      client.context.readFile(source, "dir/file", { signal: early.signal }),
    ).rejects.toThrow("early abort");
  });

  it.each(["read", "link"] as const)(
    "cancels an in-flight %s request before it can publish a result",
    async (operation) => {
      const source = await importFiles(work.store, { file: "value" });
      const file = (await work.store.read(`${source}/file`)).cid.toString();
      const target = operation === "read" ? `${source}/file` : file;
      let entered!: () => void;
      let resume!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = work.store.read.bind(work.store);
      vi.spyOn(work.store, "read").mockImplementation(async (cid, options) => {
        if (cid.toString() === target) {
          entered();
          await gate;
          options?.signal?.throwIfAborted();
        }
        return original(cid, options);
      });
      const controller = new AbortController();
      const request =
        operation === "read"
          ? client.context.readFile(source, "file", {
              signal: controller.signal,
            })
          : client.context.output.link("linked", file, {
              signal: controller.signal,
            });
      const cancelled = expect(request).rejects.toThrow("cancelled");
      await started;
      controller.abort(new Error("cancelled"));
      resume();
      await cancelled;
    },
  );

  it.each(["read", "link"] as const)(
    "close aborts a pending %s open even if the backend returns after cancellation",
    async (operation) => {
      const source = await importFiles(work.store, { file: "value" });
      const file = (await work.store.read(`${source}/file`)).cid.toString();
      const target = operation === "read" ? `${source}/file` : file;
      let entered!: () => void;
      let resume!: () => void;
      let requestSignal: AbortSignal | undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = work.store.read.bind(work.store);
      vi.spyOn(work.store, "read").mockImplementation(async (cid, options) => {
        const node = await original(cid, options);
        if (cid.toString() === target) {
          requestSignal = options?.signal;
          entered();
          await gate;
        }
        return node;
      });
      const stage = vi.spyOn(work.store, "stageBlock");
      const request =
        operation === "read"
          ? client.context.readFile(source, "file")
          : client.context.output.link("linked", file);
      const rejected = expect(request).rejects.toThrow("App finished");
      await started;
      const closing = server.close();
      expect(requestSignal?.aborted).toBe(true);
      resume();
      await rejected;
      await closing;
      expect(stage).not.toHaveBeenCalled();
      if (operation === "link")
        await expect(output.finalize()).rejects.toThrow("App finished");
    },
  );

  it("link cancellation reaches staged blocks and prevents final path publication", async () => {
    const source = await importFiles(work.store, { file: "value" });
    const file = (await work.store.read(`${source}/file`)).cid.toString();
    let entered!: () => void;
    let resume!: () => void;
    let stageSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = work.store.stageBlock.bind(work.store);
    vi.spyOn(work.store, "stageBlock").mockImplementation(
      async (session, cid, block, options) => {
        if (session === output.session) {
          stageSignal = options?.signal;
          entered();
          await gate;
        }
        await original(session, cid, block, options);
      },
    );
    const controller = new AbortController();
    const request = client.context.output.link("linked", file, {
      signal: controller.signal,
    });
    const rejected = expect(request).rejects.toThrow("cancelled");
    await started;
    controller.abort(new Error("cancelled"));
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(stageSignal?.aborted).toBe(true);
    resume();
    await rejected;
    await expect(output.finalize()).rejects.toThrow("cancelled");
  });

  it("an abort between the read reply and stream exposure releases the opened stream", async () => {
    const source = await importFiles(work.store, { file: "value" });
    const controller = new AbortController();
    const original = work.store.read.bind(work.store);
    let lifetimeSignal: AbortSignal | undefined;
    vi.spyOn(work.store, "read").mockImplementation(async (cid, options) => {
      if (cid.toString() === `${source}/file`) lifetimeSignal = options?.signal;
      return original(cid, options);
    });
    transport.client.once("message", () => {
      controller.abort(new Error("late cancellation"));
    });
    await expect(
      client.context.readFile(source, "file", { signal: controller.signal }),
    ).rejects.toThrow("late cancellation");
    expect(lifetimeSignal?.aborted).toBe(true);
  });

  it.each(["complete", "cancel"] as const)(
    "reserves pending read slots with one existing stream and 32 requests (%s)",
    async (outcome) => {
      const source = await importFiles(work.store, { file: "value" });
      const existing = await client.context.readFile(source, "file");
      let entered = 0;
      let ready!: () => void;
      let resume!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = work.store.read.bind(work.store);
      vi.spyOn(work.store, "read").mockImplementation(async (cid, options) => {
        const node = await original(cid, options);
        if (cid.toString() === `${source}/file`) {
          if (++entered === 31) ready();
          await gate;
        }
        return node;
      });
      const controller = new AbortController();
      const finished = Promise.allSettled(
        Array.from({ length: 32 }, () =>
          client.context.readFile(source, "file", {
            signal: controller.signal,
          }),
        ),
      );
      await started;
      await expect(
        client.context.output.writeFile("over-quota", ReadableStream.from([])),
      ).rejects.toThrow("capacity");
      if (outcome === "cancel") controller.abort(new Error("cancelled"));
      resume();
      const results = await finished;
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(outcome === "complete" ? 31 : 0);
      expect(
        results.some(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof Error &&
            result.reason.message.includes("capacity"),
        ),
      ).toBe(true);
      for (const result of results)
        if (result.status === "fulfilled") await result.value.cancel();
      const reused = await Promise.all(
        Array.from({ length: 31 }, () =>
          client.context.readFile(source, "file"),
        ),
      );
      for (const stream of reused) await stream.cancel();
      await existing.cancel();
    },
    10000,
  );

  it("source errors, write cancellation and invalid byte chunks poison final output even if caught", async () => {
    const controller = new AbortController();
    const writing = client.context.output.writeFile(
      "cancelled",
      new ReadableStream<Uint8Array>({
        start() {
          setTimeout(() => {
            controller.abort(new Error("cancelled"));
          }, 10);
        },
      }),
      { signal: controller.signal },
    );
    await expect(writing).rejects.toThrow();
    await expect(output.finalize()).rejects.toThrow();
    await expect(
      client.context.output.writeFile(
        "bad-bytes",
        ReadableStream.from([
          "not bytes",
        ]) as unknown as ReadableStream<Uint8Array>,
      ),
    ).rejects.toThrow("must contain bytes");
    await expect(
      client.context.output.link("bad-link", appSchemaBlock.cid.toString()),
    ).rejects.toThrow();
  });

  it("rejects malformed requests and enforces stream credits without faking success", async () => {
    expect(requestFrame(null)).toBe(false);
    expect(requestFrame({ version: 2, id: 1, operation: "read" })).toBe(false);
    transport.emit("message", {});
    expect(fatal).toHaveBeenCalledWith(expect.any(Error));
    let sequence = 500;
    for (const [operation, args] of [
      ["unknown", {}],
      ["read", null],
      ["read", { rootCid: 1, path: "file" }],
      ["write", { path: 1 }],
      ["link", { path: 1 }],
      ["pull", 987],
      ["end", 987],
    ] as const)
      expect(
        (await raw(transport, sequence++, operation, args)).error,
      ).toBeDefined();
  });

  it("raw protocol honors errors, cancellation and per-stream sequential writes", async () => {
    const begin = await raw(transport, 1000, "write", { path: "raw-file" });
    const id = begin.result as number;
    expect(
      (await raw(transport, 1001, "chunk", { id, bytes: new Uint8Array([5]) }))
        .error,
    ).toBeUndefined();
    const result = await raw(transport, 1002, "end", id);
    expect(typeof result.result).toBe("string");
    expect((await raw(transport, 1003, "writeCancel", id)).error).toContain(
      "Unknown",
    );
    const other = await raw(transport, 1004, "write", { path: "cancelled" });
    expect(
      (await raw(transport, 1005, "writeCancel", other.result)).error,
    ).toBeUndefined();
    const large = await raw(transport, 1006, "write", { path: "oversize" });
    expect(
      (
        await raw(transport, 1007, "chunk", {
          id: large.result,
          bytes: new Uint8Array(CHUNK_BYTES + 1),
        })
      ).error,
    ).toContain("65536");
    await raw(transport, 1008, "writeCancel", large.result);
    transport.emit("message", {
      version: 1,
      id: 1009,
      operation: "cancel",
      args: 9999,
    });
    await expect(output.finalize()).rejects.toThrow();
  });

  it("bounded concurrent requests, transport failure and disconnect reject waiting clients", async () => {
    const replies = new EventEmitter();
    const waiters: Request[] = [];
    const port: Port = {
      send(frame, callback) {
        waiters.push(frame as Request);
        callback(null);
      },
      on(event, listener) {
        replies.on(event, listener);
      },
      off(event, listener) {
        replies.off(event, listener);
      },
    };
    const remote = createContext(port);
    const waiting = Array.from({ length: 32 }, () =>
      remote.context.output
        .link("file", appSchemaBlock.cid.toString())
        .catch((error) => error as Error),
    );
    await expect(
      remote.context.output.link("file", appSchemaBlock.cid.toString()),
    ).rejects.toThrow("capacity");
    replies.emit("message", null);
    replies.emit("message", { version: 2, id: 1 });
    replies.emit("message", { version: 1, id: 9999, result: null });
    replies.emit("disconnect");
    expect(
      (await Promise.all(waiting)).every((error) => error instanceof Error),
    ).toBe(true);
    const broken = createContext({
      ...port,
      send(_frame, callback) {
        callback(new Error("transport broken"));
      },
    });
    await expect(
      broken.context.output.link("file", appSchemaBlock.cid.toString()),
    ).rejects.toThrow("transport broken");
    broken.close();
    const invalid = createContext({
      ...port,
      send(frame, callback) {
        callback(null);
        replies.emit("message", { version: 1, id: frame.id, result: null });
      },
    });
    await expect(invalid.initialize()).rejects.toThrow(
      "Invalid IPAB context identity",
    );
    invalid.close();
    const aborting = createContext(port);
    const abort = new AbortController();
    const pending = aborting.context.output
      .link("file", appSchemaBlock.cid.toString(), { signal: abort.signal })
      .catch((error) => error as Error);
    abort.abort();
    expect(waiters.at(-1)?.operation).toBe("cancel");
    aborting.close();
    expect(await pending).toBeInstanceOf(Error);
  });

  it("close rejects unfinished output and send errors are diagnostics, not stdout RPC", async () => {
    const begin = await raw(transport, 2000, "write", { path: "unfinished" });
    expect(typeof begin.result).toBe("number");
    await server.close();
    await expect(output.finalize()).rejects.toThrow("unfinished");
    transport.failSend = new Error("failed reply");
    server = new ContextServer(
      transport as unknown as ChildProcess,
      work.store,
      owner,
      output,
      fatal,
      appSchemaBlock.cid.toString(),
    );
    await raw(transport, 2001, "unknown", {});
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: "failed reply" }),
    );
    transport.connected = false;
    transport.emit("message", {
      version: 1,
      id: 2002,
      operation: "unknown",
      args: {},
    });
    await server.close();
  });
});
