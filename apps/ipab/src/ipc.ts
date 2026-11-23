import type { ChildProcess } from "node:child_process";
import type { IpfsStore } from "@silvermoon-work/ipfs-store";
import { CID } from "multiformats/cid";
import { HostError, message, object } from "./errors.js";
import { requestFrame, type Reply } from "./context.js";
import { CHUNK_BYTES, type OutputSpace, relativePath } from "./space.js";
import type { Ownership } from "./history.js";

class ByteQueue implements AsyncIterable<Uint8Array> {
  private item: { bytes: Uint8Array; consumed: () => void } | undefined;
  private wake: (() => void) | undefined;
  private ended = false;
  private error: Error | undefined;
  async push(bytes: Uint8Array): Promise<void> {
    if (this.ended || this.error || this.item)
      throw new HostError(
        "Output stream is closed or exceeds backpressure capacity.",
      );
    await new Promise<void>((resolve) => {
      this.item = { bytes, consumed: resolve };
      this.wake?.();
    });
    const failure = this.failure();
    if (failure) throw failure;
  }
  end(error?: Error): void {
    this.ended = true;
    this.error = error;
    this.item?.consumed();
    this.wake?.();
  }
  private failure(): Error | undefined {
    return this.error;
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.error) throw this.error;
      if (this.item) {
        const item = this.item;
        this.item = undefined;
        item.consumed();
        yield item.bytes;
      } else if (this.ended) return;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
interface ReadStream {
  iterator: AsyncIterator<Uint8Array>;
  pending: Uint8Array | undefined;
  controller: AbortController;
  pulling: boolean;
}
interface WriteStream {
  queue: ByteQueue;
  task: Promise<string>;
  writing: boolean;
}

export class ContextServer {
  private readonly requests = new Map<number, AbortController>();
  private readonly reads = new Map<number, ReadStream>();
  private readonly writes = new Map<number, WriteStream>();
  private readonly tasks = new Set<Promise<void>>();
  private openingReads = 0;
  private sequence = 0;
  private closed = false;
  constructor(
    readonly child: ChildProcess,
    readonly store: IpfsStore,
    readonly owner: Ownership,
    readonly output: OutputSpace,
    readonly fatal: (error: Error) => void,
    readonly appCid: string,
  ) {
    child.on("message", this.receive);
  }
  private reply(frame: Reply): void {
    if (this.child.connected)
      this.child.send(frame, (error) => {
        if (error && !this.closed) this.fatal(error);
      });
  }
  private receive = (frame: unknown): void => {
    if (!requestFrame(frame)) {
      this.fatal(new HostError("Invalid IPAB context frame."));
      return;
    }
    if (this.closed) {
      this.reply({
        version: 1,
        id: frame.id,
        error: "Context server is closed.",
      });
      return;
    }
    if (frame.operation === "cancel") {
      this.requests
        .get(Number(frame.args))
        ?.abort(new HostError("Context operation cancelled."));
      return;
    }
    if (this.requests.size >= 32 || this.requests.has(frame.id)) {
      this.fatal(
        new HostError("Context request capacity or identity violation."),
      );
      return;
    }
    const controller = new AbortController();
    this.requests.set(frame.id, controller);
    const task = this.handle(frame.operation, frame.args, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) {
          if (frame.operation === "read")
            await this.cancelRead(Number(result), controller.signal.reason);
          if (frame.operation === "link")
            this.output.fail(controller.signal.reason);
          controller.signal.throwIfAborted();
        }
        return result;
      })
      .then(
        (result) => {
          this.reply({ version: 1, id: frame.id, result });
        },
        (error: unknown) => {
          this.reply({ version: 1, id: frame.id, error: message(error) });
        },
      )
      .finally(() => {
        this.requests.delete(frame.id);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  };
  private async cancelRead(id: number, reason: unknown): Promise<void> {
    const stream = this.reads.get(id);
    if (!stream) return;
    stream.controller.abort(reason);
    try {
      await stream.iterator.return?.();
    } finally {
      this.reads.delete(id);
    }
  }
  private async handle(
    operation: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (operation === "identity") return this.appCid;
    if (operation === "read") {
      if (this.reads.size + this.writes.size + this.openingReads >= 32)
        throw new HostError("Context stream capacity exceeded.");
      const data = object(args, "read request");
      if (typeof data.rootCid !== "string" || typeof data.path !== "string")
        throw new HostError("Invalid read request.");
      const root = CID.parse(data.rootCid).toV1().toString();
      relativePath(data.path);
      this.openingReads++;
      try {
        await this.owner.retain([root], signal);
        signal.throwIfAborted();
        const directory = await this.store.read(root, { signal });
        signal.throwIfAborted();
        if (directory.type !== "directory")
          throw new HostError("Space root must be a UnixFS directory.");
        const controller = new AbortController();
        const readSignal = AbortSignal.any([signal, controller.signal]);
        let iterator: AsyncIterator<Uint8Array> | undefined;
        try {
          const node = await this.store.read(`${root}/${data.path}`, {
            signal: readSignal,
          });
          readSignal.throwIfAborted();
          if (node.type === "directory")
            throw new HostError("readFile requires a regular UnixFS file.");
          iterator = node.content()[Symbol.asyncIterator]();
          readSignal.throwIfAborted();
          const id = ++this.sequence;
          this.reads.set(id, {
            iterator,
            pending: undefined,
            controller,
            pulling: false,
          });
          return id;
        } catch (error) {
          controller.abort(error);
          await iterator?.return?.();
          throw error;
        }
      } finally {
        this.openingReads--;
      }
    }
    if (operation === "pull" || operation === "readCancel") {
      const id = Number(args);
      const stream = this.reads.get(id);
      if (!stream) throw new HostError("Unknown read stream.");
      if (operation === "readCancel") {
        await this.cancelRead(id, new HostError("Read cancelled."));
        return null;
      }
      if (stream.pulling)
        throw new HostError(
          "Concurrent pulls on one read stream are not supported.",
        );
      stream.pulling = true;
      const abort = () => {
        stream.controller.abort(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        stream.controller.signal.throwIfAborted();
        if (!stream.pending) {
          const result = await stream.iterator.next();
          signal.throwIfAborted();
          stream.controller.signal.throwIfAborted();
          if (result.done) {
            this.reads.delete(id);
            return null;
          }
          signal.throwIfAborted();
          stream.controller.signal.throwIfAborted();
          stream.pending = result.value;
        }
        const result = stream.pending.slice(0, CHUNK_BYTES);
        stream.pending =
          stream.pending.length > CHUNK_BYTES
            ? stream.pending.slice(CHUNK_BYTES)
            : undefined;
        return result;
      } finally {
        stream.pulling = false;
        signal.removeEventListener("abort", abort);
      }
    }
    if (operation === "write") {
      if (this.reads.size + this.writes.size + this.openingReads >= 32)
        throw new HostError("Context stream capacity exceeded.");
      const data = object(args, "write request");
      if (typeof data.path !== "string")
        throw new HostError("Invalid write path.");
      const id = ++this.sequence;
      const queue = new ByteQueue();
      const task = this.output.write(data.path, queue);
      const stream: WriteStream = { queue, task, writing: false };
      this.writes.set(id, stream);
      void task.catch((error: unknown) => {
        queue.end(new HostError(message(error)));
      });
      return id;
    }
    if (
      operation === "chunk" ||
      operation === "end" ||
      operation === "writeCancel"
    ) {
      const data =
        operation === "chunk" ? object(args, "write chunk") : { id: args };
      const id = Number(data.id);
      const stream = this.writes.get(id);
      if (!stream) throw new HostError("Unknown write stream.");
      if (operation === "writeCancel") {
        const error = new HostError(
          "Output write cancelled.",
          1,
          "OUTPUT_CANCELLED",
          "commit",
        );
        this.output.fail(error);
        stream.queue.end(error);
        await stream.task.catch(() => {});
        this.writes.delete(id);
        return null;
      }
      if (stream.writing)
        throw new HostError("Concurrent writes violate stream backpressure.");
      stream.writing = true;
      try {
        if (operation === "end") {
          stream.queue.end();
          const cid = await stream.task;
          this.writes.delete(id);
          return cid;
        }
        if (
          !(data.bytes instanceof Uint8Array) ||
          data.bytes.byteLength > CHUNK_BYTES
        )
          throw new HostError(
            "Write chunk exceeds 65536 bytes or is not bytes.",
          );
        signal.throwIfAborted();
        const cancel = () => {
          stream.queue.end(new HostError("Write cancelled."));
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          await stream.queue.push(data.bytes);
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        return null;
      } catch (error) {
        this.output.fail(error);
        stream.queue.end(new HostError(message(error)));
        throw error;
      } finally {
        stream.writing = false;
      }
    }
    if (operation === "link") {
      const data = object(args, "link request");
      if (typeof data.path !== "string" || typeof data.rootCid !== "string")
        throw new HostError("Invalid link request.");
      signal.throwIfAborted();
      await this.output.link(data.path, data.rootCid, signal);
      signal.throwIfAborted();
      return null;
    }
    throw new HostError("Unknown context operation.");
  }
  async close(): Promise<void> {
    this.closed = true;
    this.child.off("message", this.receive);
    for (const request of this.requests.values())
      request.abort(new HostError("App finished."));
    for (const stream of this.writes.values()) {
      const error = new HostError(
        "App exited with unfinished output writes.",
        1,
        "OUTPUT_PENDING",
        "commit",
      );
      this.output.fail(error);
      stream.queue.end(error);
    }
    for (const stream of this.reads.values())
      stream.controller.abort(new HostError("App finished."));
    await Promise.allSettled([
      ...this.tasks,
      ...[...this.writes.values()].map((stream) => stream.task),
    ]);
    await Promise.all(
      [...this.reads.values()].map(async (stream) => {
        await stream.iterator.return?.();
      }),
    );
    this.reads.clear();
    this.writes.clear();
  }
}
