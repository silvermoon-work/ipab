import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  contentConfigPath,
  createConfiguredContent,
  readContentConfiguration,
  SharedContent,
} from "../src/node.js";
import { abortError } from "../src/errors.js";
import { validateConfiguration } from "../src/configuration.js";

test("configured stores resolve the selected file and reject malformed lower layers", async (t) => {
  const directory = resolve(".cache", `config-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const config = join(directory, "config.json");
  vi.stubEnv("TASK_CONTENT_CONFIG", config);
  t.onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const store = await createConfiguredContent({
    backend: "local",
    dataDir: join(directory, "blocks"),
  });
  try {
    const bytes = Buffer.from("configured content");
    const cid = CID.createV1(0x55, await sha256.digest(bytes));
    await store.put(cid, bytes);
    assert.deepEqual(Buffer.from(await store.block.get(cid.toString())), bytes);
  } finally {
    await store.close();
  }
  assert.equal(contentConfigPath(), config);
  await writeFile(
    config,
    JSON.stringify({ dataDir: "local", coordinationDir: "owners" }),
  );
  const local = await readContentConfiguration();
  assert.equal(local.coordinationDir, join(directory, "owners"));
  for (const value of ["{", "null", "[]", '{"backend":"local","dataDir":""}']) {
    await writeFile(config, value);
    await assert.rejects(
      readContentConfiguration({
        backend: "kubo",
        apiUrl: "http://localhost:5001",
      }),
    );
  }
  vi.stubEnv("TASK_CONTENT_CONFIG", undefined);
  vi.stubEnv("LOCALAPPDATA", undefined);
  assert.match(contentConfigPath(), /[\\/]config\.json$/);
});

test("configuration validation rejects invalid paths, URLs, limits and conflicting fields", () => {
  for (const value of [
    null,
    [],
    false,
    { dataDir: "" },
    { dataDir: 1 },
    { dataDir: "local", coordinationDir: "" },
    { dataDir: "local", gateway: "" },
    { dataDir: "local", gateway: "invalid-url" },
    { dataDir: "local", gateway: [] },
    { dataDir: "local", gateway: "file:///local" },
    { dataDir: "local", gateway: "http://localhost/#fragment" },
    { dataDir: "local", limits: null },
    { dataDir: "local", limits: [] },
    { dataDir: "local", limits: { bytes: -1 } },
    { backend: "kubo", apiUrl: "http://localhost", timeoutMs: 2_147_483_648 },
  ])
    assert.throws(() => validateConfiguration(value));
});

test("invalid local block files fail without fetching a replacement from the borrowed source", async (t) => {
  const directory = resolve(".cache", `invalid-local-${randomUUID()}`);
  const blockDirectory = join(directory, "blocks");
  await mkdir(blockDirectory, { recursive: true });
  const bytes = Buffer.from("original");
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  const path = join(blockDirectory, cid.toString());
  let reads = 0;
  const store = new SharedContent(
    directory,
    {
      block: {
        get: () => {
          reads++;
          return Promise.resolve(bytes);
        },
      },
    },
    32,
  );
  t.onTestFinished(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path, Buffer.alloc(33));
  await assert.rejects(store.block.get(cid.toString()), {
    code: "capacity_exceeded",
  });
  await writeFile(path, Buffer.from("modified"));
  await assert.rejects(store.block.get(cid.toString()), /verification/);
  await rm(path);
  await mkdir(path);
  await assert.rejects(
    store.block.get(cid.toString()),
    /Invalid shared content block/,
  );
  assert.equal(reads, 0);
});

test("public defaults and independent overrides use content-only storage", async () => {
  const directory = resolve(`.content-config-${randomUUID()}`);
  await mkdir(directory);
  try {
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify({ gateway: "http://127.0.0.1:12345", dataDir: "shared" }),
    );
    const builder = await readContentConfiguration({}, config);
    const engine = await readContentConfiguration({}, config);
    assert.ok(builder.backend === "local");
    assert.ok(engine.backend === "local");
    assert.deepEqual(engine, builder);
    assert.equal(builder.dataDir, join(directory, "shared"));
    const independent = await readContentConfiguration(
      { dataDir: join(directory, "other") },
      config,
    );
    assert.ok(independent.backend === "local");
    assert.equal(independent.gateway, builder.gateway);
    assert.notEqual(independent.dataDir, builder.dataDir);
    const overridden = await readContentConfiguration(
      { gateway: "http://127.0.0.1:23456" },
      config,
    );
    assert.ok(overridden.backend === "local");
    assert.equal(overridden.dataDir, builder.dataDir);
    await writeFile(config, '{"server.dataDir":"not-content"}');
    await assert.rejects(
      readContentConfiguration({}, config),
      /Invalid public content/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple processes publish verified blocks atomically and closing never removes shared data", async () => {
  const directory = resolve(`.content-concurrency-${randomUUID()}`);
  await mkdir(directory);
  const bytes = Buffer.alloc(100_001, 123);
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  const child = `
import {SharedContent} from ${JSON.stringify(new URL("../dist/node.js", import.meta.url).href)};
import {CID} from ${JSON.stringify(new URL("../node_modules/multiformats/dist/src/cid.js", import.meta.url).href)};
const store = new SharedContent(process.argv[1]);
await store.put(CID.parse(process.argv[2]), Buffer.alloc(100001, 123));
await store.close();`;
  try {
    await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(
          process.execPath,
          ["--input-type=module", "--eval", child, directory, cid.toString()],
          { cwd: fileURLToPath(new URL("..", import.meta.url)) },
        ),
      ),
    );
    assert.deepEqual(await readdir(join(directory, "blocks")), [
      cid.toString(),
    ]);
    const a = new SharedContent(directory),
      b = new SharedContent(directory);
    assert.deepEqual(Buffer.from(await a.block.get(cid.toString())), bytes);
    await a.close();
    assert.deepEqual(Buffer.from(await b.block.get(cid.toString())), bytes);
    await writeFile(
      join(directory, "blocks", ".pending-interrupted"),
      "partial",
    );
    assert.deepEqual(Buffer.from(await b.block.get(cid.toString())), bytes);
    await assert.rejects(b.put(cid, Buffer.from("modified")), /verification/);
    assert.deepEqual(
      await readFile(join(directory, "blocks", cid.toString())),
      bytes,
    );
    await b.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canceling one reader does not cancel another reader sharing the same acquisition", async () => {
  const directory = resolve(`.content-readers-${randomUUID()}`);
  const bytes = Buffer.from("shared acquisition");
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  let release = () => {};
  let reads = 0;
  const client = new SharedContent(directory, {
    block: {
      get: async (_cid, options = {}) =>
        new Promise<Uint8Array>((resolve, reject) => {
          reads++;
          const abort = () => {
            if (options.signal) reject(abortError(options.signal));
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          release = () => {
            options.signal?.removeEventListener("abort", abort);
            resolve(bytes);
          };
        }),
    },
  });
  const canceled = new AbortController();
  const first = assert.rejects(
    client.block.get(cid.toString(), { signal: canceled.signal }),
    /one reader canceled/,
  );
  const second = client.block.get(cid.toString()).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    const deadline = Date.now() + 2000;
    while (!reads) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    canceled.abort(new Error("one reader canceled"));
    await first;
    release();
    const result = await second;
    assert.equal(
      "error" in result,
      false,
      "Another reader must keep the shared acquisition alive.",
    );
    if ("value" in result) assert.deepEqual(Buffer.from(result.value), bytes);
    assert.equal(reads, 1);
  } finally {
    release();
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
