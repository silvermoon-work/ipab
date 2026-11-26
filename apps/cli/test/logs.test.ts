import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdir,
  readFile,
  writeFile,
  rmdir,
  unlink,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ExecutionLogs, logFiles, removeLogs } from "../src/logs.js";
import { State } from "../src/state.js";
import { removeHistory } from "../src/history.js";
import { fixture, record } from "./helpers.js";
import { appSchemaCid } from "../src/space.js";

let work: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  work = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await work.cleanup();
});

it(
  "forwards large binary streams with backpressure without ending the destination",
  { tags: ["release-e2e"] },
  async () => {
    const logs = await ExecutionLogs.create(work.stateDir, "binary");
    const input = Buffer.alloc(1024 * 1024, 255);
    const chunks: Buffer[] = [];
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        setImmediate(done);
      },
    });
    await logs.forward(
      Readable.from([input, Buffer.from([0, 1])]),
      destination,
      "stdout",
    );
    await logs.close();
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.concat([input, Buffer.from([0, 1])]),
    );
    expect(
      await readFile(join(work.stateDir, "logs", "binary", "stdout.log")),
    ).toEqual(Buffer.concat(chunks));
    expect(destination.writableEnded).toBe(false);
    await removeLogs(work.stateDir, "binary");
    await removeLogs(work.stateDir, "binary");
  },
);

it(
  "surfaces forwarding errors and invalid output instead of reporting complete recording",
  { tags: ["release-e2e"] },
  async () => {
    const logs = await ExecutionLogs.create(work.stateDir, "failed");
    const destination = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error("broken pipe"));
      },
    });
    destination.on("error", () => {});
    await expect(
      logs.forward(Readable.from([Buffer.from("x")]), destination, "stderr"),
    ).rejects.toThrow("broken pipe");
    await expect(
      logs.forward(Readable.from(["invalid"]), destination, "stdout"),
    ).rejects.toThrow("Invalid execution output");
    await logs.close();
  },
);

it(
  "treats manually removed files as absent and deletes logs with unretained history",
  { tags: ["release-e2e"] },
  async () => {
    const logs = await ExecutionLogs.create(work.stateDir, "unretained");
    await logs.close();
    await unlink(join(work.stateDir, "logs", "unretained", "stdout.log"));
    const state = new State(work.stateDir);
    try {
      state.saveRun(
        record("unretained", appSchemaCid.toString(), { log: "complete" }),
      );
      expect(await logFiles(work.stateDir, "unretained")).toEqual({
        stdout: null,
        stderr: join(work.stateDir, "logs", "unretained", "stderr.log"),
      });
      await removeHistory(state, ["unretained"], () => {
        throw new Error("must not access Store");
      });
      expect(state.runs()).toEqual([]);
      await expect(
        access(join(work.stateDir, "logs", "unretained")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      state.close();
    }
  },
);

it(
  "failed log deletion preserves history for retry and never deletes unexpected files",
  { tags: ["release-e2e"] },
  async () => {
    const logs = await ExecutionLogs.create(work.stateDir, "retry");
    await logs.close();
    const extra = join(work.stateDir, "logs", "retry", "foreign.txt");
    await writeFile(extra, "keep");
    const state = new State(work.stateDir);
    try {
      state.saveRun(
        record("retry", appSchemaCid.toString(), { log: "complete" }),
      );
      await expect(removeHistory(state, ["retry"])).rejects.toThrow(
        "History removal incomplete",
      );
      expect(state.run("retry").log).toBe("complete");
      expect((await readFile(extra)).toString()).toBe("keep");
      await unlink(extra);
      await removeHistory(state, ["retry"]);
      expect(state.runs()).toEqual([]);
    } finally {
      state.close();
    }
  },
);

it(
  "rejects invalid paths and directory/file substitutions without deleting them",
  { tags: ["release-e2e"] },
  async () => {
    await mkdir(join(work.stateDir, "logs"), { recursive: true });
    await expect(logFiles(work.stateDir, "../escape")).rejects.toThrow(
      "Invalid execution log identity",
    );
    await writeFile(join(work.stateDir, "logs", "not-directory"), "");
    await expect(logFiles(work.stateDir, "not-directory")).rejects.toThrow(
      "Invalid execution log directory",
    );
    await mkdir(join(work.stateDir, "logs", "bad-file"));
    await mkdir(join(work.stateDir, "logs", "bad-file", "stdout.log"));
    await expect(removeLogs(work.stateDir, "bad-file")).rejects.toThrow(
      "Invalid execution log file",
    );
    await rmdir(join(work.stateDir, "logs", "bad-file", "stdout.log"));
    await expect(
      ExecutionLogs.create(work.stateDir, "bad-file"),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(logFiles(work.stateDir, "missing")).resolves.toEqual({
      stdout: null,
      stderr: null,
    });
  },
);
