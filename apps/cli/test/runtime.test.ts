import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile, readFile, access, unlink, watch } from "node:fs/promises";
import { join } from "node:path";
import { IpfsStore } from "@ipab/ipfs-store";
import { encodeSchema } from "@ipab/bundle";
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { State } from "../src/state.js";
import { appDescription } from "../src/app-definition.js";
import {
  bytes,
  OutputSpace,
  relativePath,
  validatedBundle,
  loadApp,
  appSchemaCid,
  appSchema,
  CHUNK_BYTES,
} from "../src/space.js";
import { Ownership } from "../src/history.js";
import { execute } from "../src/runtime.js";
import { addPin, renamePin } from "../src/pins.js";
import { ExecutionLogs, logFiles } from "../src/logs.js";
import { parse } from "../src/cli.js";
import {
  app,
  cli,
  content,
  fixture,
  importFiles,
  subprocess,
  schemaCar,
} from "./helpers.js";

async function invalidBlock(store: IpfsStore): Promise<CID> {
  const bytes = dagPb.encode(
    dagPb.prepare({ Data: Uint8Array.of(0xff), Links: [] }),
  );
  const cid = CID.createV1(dagPb.code, await sha256.digest(bytes));
  await store.put(cid, bytes);
  return cid;
}

const metadata = {
  name: "Reader",
  version: "1.2.3-rc.0+build.1",
  description: "Base description",
  entry: "resources/app.cjs",
  author: { name: "Author", email: "author@example.com" },
  license: "Proprietary; declarative only",
  icon: "resources/icon.svg",
  i18n: {
    "zh-CN": { name: "阅读器" },
    en: { description: "English description" },
  },
};

describe("App metadata validation", { tags: ["unit"] }, () => {
  it.each([
    [{ name: "  " }, "App name"],
    [{ version: "1.2.3-01" }, "SemVer"],
    [{ version: "1.2.3+bad..id" }, "SemVer"],
    [{ author: { name: "" } }, "Author name"],
    [{ author: { name: "A", email: "not-an-email" } }, "Author email"],
    [{ license: "" }, "App license"],
    [{ i18n: { not_a_tag: { name: "Name" } } }, "Invalid i18n language tag"],
    [{ i18n: { en: { name: "" } } }, "Translated name"],
    [{ i18n: { "en-US": {}, "en-us": {} } }, "Duplicate i18n language tag"],
  ] as const)(
    "rejects invalid concrete App metadata %#",
    (overrides, error) => {
      expect(() => appDescription({ ...metadata, ...overrides })).toThrow(
        error,
      );
    },
  );
});

describe(
  "real UnixFS and Node subprocess runtime",
  { tags: ["release-e2e"] },
  () => {
    let work: Awaited<ReturnType<typeof fixture>>;
    let state: State;
    let config: string;
    beforeEach(async () => {
      work = await fixture();
      state = new State(work.stateDir);
      config = join(work.root, "store.json");
      await writeFile(config, JSON.stringify(work.store.configuration));
      vi.stubEnv("TASK_CONTENT_CONFIG", config);
    });
    afterEach(async () => {
      state.close();
      await work.cleanup();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it("rebuilds the fixed runtime Node profile identity as one DAG-CBOR block", async () => {
      const encoded = await encodeSchema(appSchema);
      expect(encoded.cid.equals(appSchemaCid)).toBe(true);
      expect(encoded.cid.toString()).toBe(
        "bafyreifualoac4ddlzl63jlfstz4xsq75cai5t6ywu3j3khhyukoccmybm",
      );
      const legacy = {
        ...appSchema,
        schema: {
          ...appSchema.schema,
          properties: Object.fromEntries(
            Object.entries(appSchema.schema.properties).filter(
              ([key]) => key !== "source",
            ),
          ),
        },
      };
      expect((await encodeSchema(legacy)).cid.equals(encoded.cid)).toBe(false);
      const root = await importFiles(work.store, {
        ".bundle.yaml": JSON.stringify({
          title: "Untitled App",
          entry: "app.json",
          type: ".bundle-type.yaml",
        }),
        ".bundle-type.yaml": JSON.stringify(legacy),
        "app.json": JSON.stringify({
          name: "Untitled App",
          version: "0.0.0",
          description: "",
          entry: "resources/app.cjs",
        }),
        "resources/app.cjs": "throw new Error('must not execute');",
      });
      const owner = await Ownership.create(
        state,
        work.store,
        "legacy-app",
        null,
      );
      try {
        await expect(loadApp(root, work.store, owner)).rejects.toMatchObject({
          code: "APP_PROFILE_INVALID",
        });
      } finally {
        await owner.release();
      }
    });

    it("derives the complete type from the retained directory without fetching an external schema", async () => {
      const input = await content(work.store);
      const owner = await Ownership.create(
        state,
        work.store,
        "schema-retention",
        null,
      );
      try {
        const bundle = await validatedBundle(input.root, work.store, owner);
        expect(bundle.schemaKey).toBe(input.schema);
        expect(state.hold(owner.owner)?.roots).toContain(input.root);
        expect(state.hold(owner.owner)?.roots).not.toContain(input.schema);
      } finally {
        await owner.release();
      }
      expect(state.hold(owner.owner)).toBeUndefined();
    });
    it("executes an App whose descriptor was moved without changing its type identity", async () => {
      const root = await app(
        work.store,
        "process.stdout.write('moved descriptor');",
        undefined,
        "metadata/description.json",
      );
      const result = await subprocess(
        ["--state-dir", work.stateDir, "exec", root],
        config,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.toString()).toBe("moved descriptor");
    });

    it.each([false, true])(
      "ordinary argv/stdin/binary stdout remain exact with logging=%s",
      async (log) => {
        const source = `const fs = require("node:fs");
const input = fs.readFileSync(0);
process.stdout.write(input);
process.stderr.write(JSON.stringify(process.argv.slice(2)) + "\\n");
(async () => {
  await ipab.output.writeFile("nested/result.bin", new ReadableStream({start(c) { c.enqueue(input); c.close(); }}));
  await ipab.output.writeFile("second.txt", new ReadableStream({start(c) { c.enqueue(Buffer.from("two")); c.close(); }}));
})().catch(e => {console.error(e); process.exitCode = 9;});`;
        const root = await app(work.store, source);
        const argv = ["--help", "--cid", "--", "--json", "a b", "%", "☃"];
        const input = Buffer.from([0, 255, 1, 2, 13, 10]);
        const result = await subprocess(
          [
            "--state-dir",
            work.stateDir,
            "exec",
            ...(log ? ["--log"] : []),
            root,
            ...argv,
          ],
          config,
          input,
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toEqual(input);
        expect(result.stderr).toContain(JSON.stringify(argv));
        const run = state.runs()[0]!;
        expect(run.status).toBe("succeeded");
        expect(run.appCid).toBe(root);
        expect(run.argv).toEqual(argv);
        expect(run.retention.owned).toBe(true);
        expect(run.outputCid).not.toBe(root);
        expect((await work.store.read(run.outputCid!)).type).toBe("directory");
        const resultNode = await work.store.read(
          `${run.outputCid}/nested/result.bin`,
        );
        expect(resultNode.type).not.toBe("directory");
        if (resultNode.type !== "directory")
          expect(
            await bytes(ReadableStream.from(resultNode.content()), 100),
          ).toEqual(Uint8Array.from(input));
        const second = await work.store.read(`${run.outputCid}/second.txt`);
        if (second.type !== "directory")
          expect(
            new TextDecoder().decode(
              await bytes(ReadableStream.from(second.content()), 100),
            ),
          ).toBe("two");
        expect(result.stdout.toString()).not.toContain(run.outputCid!);
        expect(result.stderr).toContain(`Output: ${run.outputCid}`);
        const files = await logFiles(work.stateDir, run.id);
        if (log) {
          expect(run.log).toBe("complete");
          expect(await readFile(files.stdout!)).toEqual(input);
          expect((await readFile(files.stderr!)).toString()).toBe(
            JSON.stringify(argv) + "\n",
          );
          const shown = await cli(work.stateDir, [
            "--json",
            "history",
            "show",
            run.id,
          ]);
          expect(JSON.parse(shown.out) as unknown).toMatchObject({
            log: "complete",
            logs: files,
          });
          await unlink(files.stdout!);
          const missing = await cli(work.stateDir, ["history", "show", run.id]);
          expect(missing.out).toContain("Stdout log: unavailable");
          expect(missing.out).toContain(files.stderr!);
          expect(
            (await cli(work.stateDir, ["history", "remove", run.id, "--yes"]))
              .code,
          ).toBe(0);
          await expect(
            access(join(work.stateDir, "logs", run.id)),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(run.log).toBeUndefined();
          expect(files).toEqual({ stdout: null, stderr: null });
        }
      },
      20000,
    );

    it("log flag is host-only before APP and fails before execution with history disabled", async () => {
      expect(parse(["exec", "--log", "--help"]).help).toBe(true);
      expect(parse(["exec", "--log", "reader", "--log"]).positional).toEqual([
        "reader",
        "--log",
      ]);
      expect(() => parse(["exec", "--log"])).toThrow("Expected APP");
      expect(() => parse(["exec", "--log", "--log", "reader"])).toThrow(
        "Duplicate option --log",
      );
      const root = await app(
        work.store,
        "throw new Error('must not execute');",
      );
      state.setConfig("history.enabled", false);
      const result = await subprocess(
        ["--state-dir", work.stateDir, "exec", "--log", root],
        config,
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("requires history.enabled=true");
      expect(state.runs()).toEqual([]);
    });

    it("failed Apps retain complete debug output and logging failures are recorded explicitly", async () => {
      const root = await app(
        work.store,
        "console.log('debug'); console.error('failure'); process.exitCode = 7;",
      );
      const result = await subprocess(
        ["--state-dir", work.stateDir, "exec", "--log", root],
        config,
      );
      expect(result.code).toBe(7);
      const run = state.runs()[0]!;
      expect(run).toMatchObject({
        status: "failed",
        log: "complete",
        appExitCode: 7,
      });
      const files = await logFiles(work.stateDir, run.id);
      expect((await readFile(files.stdout!)).toString()).toBe("debug\n");
      expect((await readFile(files.stderr!)).toString()).toBe("failure\n");
      expect(
        (await cli(work.stateDir, ["history", "remove", run.id, "--yes"])).code,
      ).toBe(0);
      await expect(
        access(join(work.stateDir, "logs", run.id)),
      ).rejects.toMatchObject({ code: "ENOENT" });

      vi.spyOn(ExecutionLogs.prototype, "forward").mockRejectedValue(
        new Error("disk full"),
      );
      const execution = await execute(
        state,
        work.store,
        { origin: "exec", appCid: root, argv: [] },
        {
          history: true,
          retain: false,
          log: true,
          diagnostic: () => {},
        },
      );
      expect(execution.exitCode).not.toBe(0);
      expect(execution.record.log).toBe("incomplete");
      expect(execution.record.error?.message).toContain("disk full");
      expect(execution.record.outputCid).toBeNull();
    }, 20000);

    it("reads arbitrary Space without manifest and links only valid UnixFS file/directory targets", async () => {
      const space = await importFiles(work.store, {
        "raw/data.bin": new Uint8Array(CHUNK_BYTES * 3).fill(42),
        "other.txt": "value",
      });
      const file = (await work.store.read(`${space}/other.txt`)).cid.toString();
      const source = `(async () => {
  const stream = await ipab.readFile(process.argv[2], "raw/data.bin");
  await ipab.output.writeFile("copy.bin", stream);
  await ipab.output.writeFile("self-description.json", await ipab.readFile(ipab.appCid, "app.json"));
  await ipab.output.link("linked-tree", process.argv[2]);
  await ipab.output.link("linked-file", process.argv[3]);
})().catch(e => { console.error(e); process.exitCode = 7; });`;
      const root = await app(work.store, source);
      const result = await subprocess(
        ["--state-dir", work.stateDir, "exec", root, space, file],
        config,
      );
      expect(result.code, result.stderr).toBe(0);
      const output = state.runs()[0]!.outputCid!;
      const copy = await work.store.read(`${output}/copy.bin`);
      if (copy.type !== "directory")
        expect(
          (await bytes(ReadableStream.from(copy.content()), CHUNK_BYTES * 3))
            .length,
        ).toBe(CHUNK_BYTES * 3);
      expect(
        (await work.store.read(`${output}/linked-file`)).cid.toString(),
      ).toBe(file);
      expect(
        (await work.store.read(`${output}/linked-tree`)).cid.toString(),
      ).toBe(space);
      const own = await work.store.read(`${output}/self-description.json`);
      if (own.type !== "directory")
        expect(
          JSON.parse(
            new TextDecoder().decode(
              await bytes(ReadableStream.from(own.content()), 1024),
            ),
          ) as unknown,
        ).toEqual({
          name: "Fixture App",
          version: "0.0.0",
          description: "",
          entry: "resources/app.cjs",
        });
      const badApp = await app(
        work.store,
        `(async()=>{try {await ipab.output.link("not-unixfs", process.argv[2]);} catch(e) {console.error(e.message);}})();`,
      );
      const bad = await subprocess(
        [
          "--state-dir",
          work.stateDir,
          "exec",
          badApp,
          (await invalidBlock(work.store)).toString(),
        ],
        config,
      );
      expect(bad.code).toBe(1);
      expect(
        state.runs().find((run) => run.appCid === badApp)?.outputCid,
      ).toBeNull();
    }, 20000);

    it("rejects a linked directory with a non-UnixFS DAG-PB descendant", async () => {
      const invalid = dagPb.encode(
        dagPb.prepare({ Data: Uint8Array.of(0xff), Links: [] }),
      );
      const invalidCid = CID.createV1(dagPb.code, await sha256.digest(invalid));
      await work.store.put(invalidCid, invalid);
      const directory = dagPb.encode(
        dagPb.prepare({
          Data: new UnixFS({ type: "directory" }).marshal(),
          Links: [{ Name: "invalid", Hash: invalidCid, Tsize: invalid.length }],
        }),
      );
      const root = CID.createV1(dagPb.code, await sha256.digest(directory));
      await work.store.put(root, directory);
      expect((await work.store.read(root)).type).toBe("directory");
      await expect(
        work.store.read(`${root.toString()}/invalid`),
      ).rejects.toThrow();
      const owner = await Ownership.create(
        state,
        work.store,
        "invalid-link",
        "invalid-link-stage",
      );
      try {
        const output = new OutputSpace(work.store, owner, "invalid-link-stage");
        await expect(output.link("tree", root.toString())).rejects.toThrow();
        await expect(output.finalize()).rejects.toThrow();
      } finally {
        await owner.release();
      }
    });

    it("open validates Content Bundle, expands whole tokens and uses saved exact association", async () => {
      const input = await content(work.store);
      const schema = await encodeSchema(input.definition);
      const root = await app(
        work.store,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
        schemaCar([schema.cid], [schema]),
      );
      await addPin(state, "document", input.root, work.store.configuration);
      await addPin(state, "program", root, work.store.configuration);
      state.setAssociation(
        input.schema,
        "program",
        ["--cid", "%", "--literal=%", "%"],
        false,
      );
      renamePin(state, "program", "renamed-program");
      const result = await subprocess(
        ["--state-dir", work.stateDir, "open", "--log", "document"],
        config,
      );
      expect(result.code, result.stderr).toBe(0);
      const actual = ["--cid", input.root, "--literal=%", input.root];
      expect(result.stdout.toString()).toBe(JSON.stringify(actual));
      expect(state.runs()[0]?.argv).toEqual(actual);
      expect(state.runs()[0]?.origin).toBe("open");
      const logs = await logFiles(work.stateDir, state.runs()[0]!.id);
      expect((await readFile(logs.stdout!)).toString()).toBe(
        JSON.stringify(actual),
      );
      state.removeAssociation(input.schema);
      const missing = await subprocess(
        ["--state-dir", work.stateDir, "open", input.root],
        config,
      );
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("register set or ipab exec");
      expect(state.runs()).toHaveLength(1);
    }, 20000);
    it("open requires exact declared support before child invocation, while exec preserves ordinary argv", async () => {
      const input = await content(work.store);
      const supported = await encodeSchema(input.definition);
      const other = await encodeSchema({
        ...input.definition,
        contentType: "application/yaml",
      });
      const source =
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));";
      const omitted = await app(work.store, source);
      const mismatch = await app(
        work.store,
        source,
        schemaCar([other.cid], [other]),
      );
      for (const root of [omitted, mismatch]) {
        state.setAssociation(input.schema, root, ["%"], true);
        const result = await subprocess(
          ["--state-dir", work.stateDir, "open", input.root],
          config,
        );
        expect(result.code).toBe(1);
        expect(result.stdout.length).toBe(0);
        expect(result.stderr).toContain("does not declare support");
        expect(result.stderr).toContain("ipab.yaml supportedSchemas");
        const run = state.runs().find((run) => run.appCid === root)!;
        expect(run.appExitCode).toBeNull();
        expect(run.outputCid).toBeNull();
        expect(run.error).toMatchObject({
          phase: "validation",
          code: "APP_SCHEMA_UNSUPPORTED",
        });
      }
      const multi = await app(
        work.store,
        source,
        schemaCar([other.cid, supported.cid], [supported, other]),
      );
      state.setAssociation(input.schema, multi, ["--cid", "%"], true);
      const opened = await subprocess(
        ["--state-dir", work.stateDir, "open", input.root],
        config,
      );
      expect(opened.code, opened.stderr).toBe(0);
      expect(opened.stdout.toString()).toBe(
        JSON.stringify(["--cid", input.root]),
      );
      const argv = ["--help", "--json", "--", "%", "--cid=unrelated"];
      const explicit = await subprocess(
        ["--state-dir", work.stateDir, "exec", mismatch, ...argv],
        config,
      );
      expect(explicit.code, explicit.stderr).toBe(0);
      expect(explicit.stdout.toString()).toBe(JSON.stringify(argv));
    }, 60000);

    it("validates nested Schema CARs even for exec without importing or retaining nested roots", async () => {
      const input = await content(
        work.store,
        { hello: "world" },
        {
          type: "object",
          properties: { hello: { const: "world" } },
          required: ["hello"],
        },
      );
      const schema = await encodeSchema(input.definition);
      const other = await encodeSchema({
        ...input.definition,
        contentType: "application/yaml",
      });
      const owner = await Ownership.create(
        state,
        work.store,
        "nested-schemas",
        null,
      );
      try {
        const valid = await app(
          work.store,
          "",
          schemaCar([schema.cid, other.cid], [other, schema]),
        );
        const loaded = await loadApp(valid, work.store, owner);
        expect([...loaded.supportedSchemas].sort()).toEqual(
          [schema.cid.toString(), other.cid.toString()].sort(),
        );
        expect(state.hold(owner.owner)?.roots).not.toContain(
          schema.cid.toString(),
        );
        expect(state.hold(owner.owner)?.roots).not.toContain(
          other.cid.toString(),
        );
        await expect(
          work.store.block.get(schema.cid.toString()),
        ).rejects.toThrow();
        await expect(
          work.store.block.get(other.cid.toString()),
        ).rejects.toThrow();
        const invalidDefinition = Uint8Array.from(schema.bytes);
        const offset = Buffer.from(invalidDefinition).lastIndexOf("object");
        invalidDefinition.set(Buffer.from("broken"), offset);
        const invalidCid = CID.createV1(
          0x71,
          await sha256.digest(invalidDefinition),
        );
        const bare = Uint8Array.of(0xa0);
        const bareCid = CID.createV1(0x71, await sha256.digest(bare));
        for (const nested of [
          Uint8Array.of(1, 2, 3),
          schemaCar([], []),
          schemaCar([schema.cid], []),
          schemaCar([schema.cid, schema.cid], [schema]),
          schemaCar([schema.cid], [schema, schema]),
          schemaCar([schema.cid], [schema, other]),
          schemaCar(
            [schema.cid],
            [{ cid: schema.cid, bytes: Uint8Array.of(1) }],
          ),
          schemaCar([bareCid], [{ cid: bareCid, bytes: bare }]),
          schemaCar(
            [invalidCid],
            [{ cid: invalidCid, bytes: invalidDefinition }],
          ),
          schemaCar(
            [CID.createV1(0x55, schema.cid.multihash)],
            [
              {
                cid: CID.createV1(0x55, schema.cid.multihash),
                bytes: schema.bytes,
              },
            ],
          ),
        ]) {
          const root = await app(
            work.store,
            "throw new Error('must not execute');",
            nested,
          );
          await expect(loadApp(root, work.store, owner)).rejects.toThrow();
        }
      } finally {
        await owner.release();
      }
    }, 30000);

    it("rejects unsafe supported Schema paths and corrupt nested CARs before execution", async () => {
      const owner = await Ownership.create(
        state,
        work.store,
        "unsafe-schema-paths",
        null,
      );
      try {
        const files = {
          ".bundle.yaml": JSON.stringify({
            title: "App",
            entry: "app.json",
            type: ".bundle-type.yaml",
          }),
          ".bundle-type.yaml": JSON.stringify(appSchema),
          "resources/app.cjs": "throw new Error('must not execute');",
        };
        for (const supportedSchemas of [
          "",
          " ",
          "../schemas.car",
          "app.json",
          "resources/app.cjs",
          "resources/missing.car",
        ]) {
          const root = await importFiles(work.store, {
            ...files,
            "app.json": JSON.stringify({
              name: "Untitled App",
              version: "0.0.0",
              description: "",
              entry: "resources/app.cjs",
              supportedSchemas,
            }),
          });
          await expect(loadApp(root, work.store, owner)).rejects.toThrow();
        }
      } finally {
        await owner.release();
      }
      const corrupt = await app(
        work.store,
        "process.stdout.write('must not execute');",
        Uint8Array.of(1),
      );
      const result = await subprocess(
        ["--state-dir", work.stateDir, "exec", corrupt, "--help"],
        config,
      );
      expect(result.code).toBe(1);
      expect(result.stdout.length).toBe(0);
      expect(state.runs()[0]?.appExitCode, result.stderr).toBeNull();
    }, 30000);
    it.each(["other/app.cjs", "resources/app.js"])(
      "enforces Node entry paths outside the structural schema: %s",
      async (entry) => {
        const root = await importFiles(work.store, {
          ".bundle.yaml": JSON.stringify({
            title: "App",
            entry: "app.json",
            type: ".bundle-type.yaml",
          }),
          ".bundle-type.yaml": JSON.stringify(appSchema),
          "app.json": JSON.stringify({
            name: "Fixture App",
            version: "0.0.0",
            entry,
          }),
          [entry]: "throw new Error('must not execute');",
        });
        const owner = await Ownership.create(
          state,
          work.store,
          "invalid-app-entry",
          null,
        );
        try {
          await expect(loadApp(root, work.store, owner)).rejects.toMatchObject({
            code: "APP_PROFILE_INVALID",
          });
        } finally {
          await owner.release();
        }
      },
    );
    const files = {
      ".bundle.yaml": JSON.stringify({
        title: "App",
        entry: "app.json",
        type: ".bundle-type.yaml",
      }),
      ".bundle-type.yaml": JSON.stringify(appSchema),
      "resources/app.cjs": 'process.stdout.write("licensed app still runs");',
      "resources/icon.svg": "<svg/>",
    };
    it("validates concrete App metadata without changing type identity or enforcing licenses", async () => {
      const root = await importFiles(work.store, {
        ...files,
        "app.json": JSON.stringify(metadata),
      });
      const other = await importFiles(work.store, {
        ...files,
        "app.json": JSON.stringify({
          ...metadata,
          name: "Another App",
          version: "2.0.0",
        }),
      });
      expect(other).not.toBe(root);
      const owner = await Ownership.create(
        state,
        work.store,
        "metadata-validation",
        null,
      );
      try {
        for (const cid of [root, other]) {
          expect(
            (await validatedBundle(cid, work.store, owner)).schemaKey,
          ).toBe(appSchemaCid.toString());
          expect((await loadApp(cid, work.store, owner)).path).toBe(
            "resources/app.cjs",
          );
        }
      } finally {
        await owner.release();
      }
      const run = await subprocess(
        ["--state-dir", work.stateDir, "exec", root],
        config,
      );
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout.toString()).toBe("licensed app still runs");
    }, 30000);
    it.each([
      { version: "01.2.3" },
      { icon: "../icon.svg" },
      { icon: "app.json" },
      { icon: "resources/missing.svg" },
      { i18n: { en: { icon: "x" } } },
      { i18n: { en: { description: 1 } } },
      { profile: "ipab.node.v1", runtime: "node" },
    ])(
      "rejects invalid concrete App metadata %#",
      async (overrides) => {
        const invalid = await importFiles(work.store, {
          ...files,
          "app.json": JSON.stringify({ ...metadata, ...overrides }),
        });
        const owner = await Ownership.create(
          state,
          work.store,
          "invalid-metadata-validation",
          null,
        );
        try {
          await expect(loadApp(invalid, work.store, owner)).rejects.toThrow();
        } finally {
          await owner.release();
        }
      },
      30000,
    );
    it("empty success finalizes an empty UnixFS directory; failed app preserves its exit without partial output", async () => {
      const empty = await app(work.store, "process.stdout.write('plain');");
      const good = await subprocess(
        ["--state-dir", work.stateDir, "exec", empty],
        config,
      );
      expect(good.code, good.stderr).toBe(0);
      expect(good.stdout.toString()).toBe("plain");
      const emptyRoot = state.runs()[0]!.outputCid!;
      const directory = await work.store.read(emptyRoot);
      if (directory.type === "directory") {
        const entries = [];
        for await (const item of directory.entries()) entries.push(item);
        expect(entries).toEqual([]);
      }
      const failed = await app(
        work.store,
        `(async()=> {
await ipab.output.writeFile("partial",new ReadableStream({start(c){c.enqueue(Buffer.from("partial"));c.close();}}));
process.exitCode=23; })();`,
      );
      const bad = await subprocess(
        ["--state-dir", work.stateDir, "exec", failed],
        config,
      );
      expect(bad.code).toBe(23);
      const record = state.runs().find((run) => run.appCid === failed)!;
      expect(record.status).toBe("failed");
      expect(record.appExitCode).toBe(23);
      expect(record.outputCid).toBeNull();
      expect(record.retention.owned).toBe(false);
      expect(record.error?.phase).toBe("execution");
    }, 20000);

    it("unfinished/caught failed writes cannot become fake successes", async () => {
      const pending = await app(
        work.store,
        `(async()=> {
await ipab.output.writeFile("pending", new ReadableStream({pull(){return new Promise(()=>{});}}));
})();`,
      );
      const result = await subprocess(
        ["--state-dir", work.stateDir, "exec", pending],
        config,
      );
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("unfinished output");
      const broken = await app(
        work.store,
        `(async()=> {
try {await ipab.output.writeFile("broken", new ReadableStream({start(c){c.error(new Error("stream broke"));}}));} catch(e) {}
})();`,
      );
      const failed = await subprocess(
        ["--state-dir", work.stateDir, "exec", broken],
        config,
      );
      expect(failed.code).toBe(1);
      expect(
        state
          .runs()
          .every((run) => run.outputCid === null && run.status === "failed"),
      ).toBe(true);
    }, 20000);

    it("protects every constructed block from first write; failed finalization and cleanup are nonzero", async () => {
      const root = await app(
        work.store,
        `(async()=>{await ipab.output.writeFile("file",new ReadableStream({start(c){c.enqueue(Buffer.from("data"));c.close();}}));})();`,
      );
      const stage = vi.spyOn(work.store, "stageBlock");
      const put = vi.spyOn(work.store, "put");
      const diagnostics: string[] = [];
      const result = await execute(
        state,
        work.store,
        { origin: "exec", appCid: root, argv: [] },
        {
          history: true,
          retain: true,
          diagnostic: (text) => {
            diagnostics.push(text);
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(stage).toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      const finish = vi
        .spyOn(work.store, "finishImport")
        .mockRejectedValueOnce(new Error("commit failed"));
      const failure = await execute(
        state,
        work.store,
        { origin: "exec", appCid: root, argv: [] },
        {
          history: true,
          retain: false,
          diagnostic: (text) => {
            diagnostics.push(text);
          },
        },
      );
      expect(failure.exitCode).toBe(1);
      expect(failure.record.appExitCode).toBe(0);
      expect(failure.record.outputCid).toBeNull();
      expect(failure.record.error?.phase).toBe("commit");
      finish.mockRestore();
      const discard = vi
        .spyOn(work.store, "discardImport")
        .mockRejectedValueOnce(new Error("cleanup failed"));
      const cleanup = await execute(
        state,
        work.store,
        { origin: "exec", appCid: root, argv: [] },
        {
          history: true,
          retain: false,
          diagnostic: (text) => {
            diagnostics.push(text);
          },
        },
      );
      expect(cleanup.exitCode).toBe(1);
      expect(cleanup.record.error?.phase).toBe("cleanup");
      expect(state.run(cleanup.record.id).status).toBe("failed");
      discard.mockRestore();
    }, 20000);

    it("history-off and no-retention modes do not capture stdio or create hidden permanent pins", async () => {
      const root = await app(work.store, "process.stdout.write('hello');");
      const diagnostics: string[] = [];
      const result = await execute(
        state,
        work.store,
        { origin: "exec", appCid: root, argv: ["sensitive-arg"] },
        {
          history: false,
          retain: true,
          diagnostic: (text) => {
            diagnostics.push(text);
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(state.runs()).toEqual([]);
      expect(diagnostics.join("\n")).toContain("no history-owned retention");
      expect(work.store.pins()).not.toContain(result.record.outputCid);
      const unretained = await execute(
        state,
        work.store,
        { origin: "exec", appCid: root, argv: [] },
        {
          history: true,
          retain: false,
          diagnostic: () => {},
        },
      );
      expect(unretained.record.retention).toEqual({
        owned: false,
        state: "none",
      });
      expect(JSON.stringify(state.runs())).not.toContain("stdout");
    }, 20000);

    it("abort before launch produces a cancelled record, and invalid App profile never executes JS", async () => {
      const input = await content(work.store, { arbitrary: true });
      const cancelled = new AbortController();
      cancelled.abort();
      const result = await execute(
        state,
        work.store,
        { origin: "exec", appCid: input.root, argv: [] },
        {
          history: true,
          retain: true,
          signal: cancelled.signal,
          diagnostic: () => {},
        },
      );
      expect(result.exitCode).toBe(130);
      expect(result.record.status).toBe("cancelled");
      expect(result.record.appExitCode).toBeNull();
      const invalid = await execute(
        state,
        work.store,
        { origin: "exec", appCid: input.root, argv: [] },
        { history: true, retain: true, diagnostic: () => {} },
      );
      expect(invalid.exitCode).toBe(1);
      expect(invalid.record.error?.phase).toBe("validation");
      expect(invalid.record.appExitCode).toBeNull();
      expect((await cli(work.stateDir, ["exec", "unknown"])).code).toBe(1);
    });

    it("the source CLI dispatches exec/open through the same runtime and reports Store-close failure", async () => {
      const input = await content(work.store);
      const schema = await encodeSchema(input.definition);
      const root = await app(
        work.store,
        "process.exitCode = 0;",
        schemaCar([schema.cid], [schema]),
      );
      await addPin(state, "app", root, work.store.configuration);
      state.setAssociation(input.schema, root, ["%", "--cid=%"], false);
      const explicit = await cli(work.stateDir, [
        "exec",
        "app",
        "--help",
        "--",
      ]);
      expect(explicit.code, explicit.err).toBe(0);
      const opened = await cli(work.stateDir, ["open", input.root]);
      expect(opened.code, opened.err).toBe(0);
      expect(state.runs().find((run) => run.origin === "open")?.argv).toEqual([
        input.root,
        "--cid=%",
      ]);
      state.removeAssociation(input.schema);
      expect((await cli(work.stateDir, ["open", input.root])).err).toContain(
        "No App registered",
      );
      const originalClose = Object.getOwnPropertyDescriptor(
        IpfsStore.prototype,
        "close",
      )!.value as (this: IpfsStore) => Promise<void>;
      const failure = await cli(work.stateDir, ["exec", root], {
        diagnostic: (text) => {
          if (text.startsWith("Output:"))
            vi.spyOn(IpfsStore.prototype, "close").mockImplementationOnce(
              async function (this: IpfsStore) {
                await originalClose.call(this);
                throw new Error("close failed");
              },
            );
        },
      });
      expect(failure.code).toBe(1);
      expect(failure.err).toContain("Store cleanup failed");
      vi.restoreAllMocks();
    }, 20000);

    it("cancels a real uncooperative subprocess, bounds stopping and never commits cancelled output", async () => {
      const marker = join(work.root, "ready");
      const root = await app(
        work.store,
        `process.on("SIGINT",()=>{}); process.on("SIGTERM",()=>{});
require("node:fs").writeFileSync(process.argv[2],"ready"); setInterval(()=>{},1000);`,
      );
      const controller = new AbortController();
      const ready = (async () => {
        for await (const event of watch(work.root, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        })) {
          if (
            event.filename === "ready" &&
            (await readFile(marker, "utf8")) === "ready"
          ) {
            return;
          }
        }
        throw new Error("App did not create its readiness marker.");
      })();
      const stopping = execute(
        state,
        work.store,
        { origin: "exec", appCid: root, argv: [marker] },
        {
          history: true,
          retain: true,
          signal: controller.signal,
          diagnostic: () => {},
        },
      );
      try {
        await Promise.race([
          ready,
          stopping.then(() => {
            throw new Error("App stopped before becoming ready.");
          }),
        ]);
      } finally {
        controller.abort();
        await stopping;
      }
      const result = await stopping;
      expect(result.exitCode).toBe(130);
      expect(result.record.status).toBe("cancelled");
      expect(result.record.outputCid).toBeNull();
      expect(state.run(result.record.id).status).toBe("cancelled");
    }, 15000);

    it("JavaScript startup errors and history commit failures are explicit execution failures", async () => {
      const bad = await app(work.store, "throw new Error('startup broke');");
      const result = await execute(
        state,
        work.store,
        { origin: "exec", appCid: bad, argv: [] },
        {
          history: true,
          retain: false,
          diagnostic: () => {},
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.record.appExitCode).toBe(1);
      const root = await app(work.store, "process.exitCode = 0;");
      const save = vi.spyOn(state, "saveRun").mockImplementationOnce(() => {
        throw new Error("metadata commit failed");
      });
      const failed = await execute(
        state,
        work.store,
        { origin: "exec", appCid: root, argv: [] },
        {
          history: true,
          retain: false,
          diagnostic: () => {},
        },
      );
      expect(failed.exitCode).toBe(1);
      expect(failed.record.error?.phase).toBe("history");
      expect(failed.record.outputCid).not.toBeNull();
      save.mockRestore();
    }, 15000);

    it("safe paths, stream bounds and profile/schema validation are real", async () => {
      for (const path of [
        "",
        "../x",
        "/x",
        "x//y",
        "x\\y",
        "x/%2e",
        "x/.",
        "x/..",
        "x:",
        "x\u0000",
        "x.",
      ])
        expect(() => relativePath(path)).toThrow("Unsafe");
      expect(relativePath("nested/file.bin")).toBe("nested/file.bin");
      await expect(
        bytes(ReadableStream.from([new Uint8Array(4)]), 2),
      ).rejects.toThrow("byte limit");
      const owner = await Ownership.create(
        state,
        work.store,
        "unit",
        "unit-stage",
      );
      const output = new OutputSpace(work.store, owner, "unit-stage");
      await output.write(
        "x/a",
        (async function* () {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
      );
      await expect(
        output.write("x", (async function* () {})()),
      ).rejects.toThrow("overlap");
      await expect(output.finalize()).rejects.toThrow("overlap");
      await owner.release();
      const invalid = await importFiles(work.store, {
        ".bundle.yaml": "bad",
        data: "plain",
      });
      const validationOwner = await Ownership.create(
        state,
        work.store,
        "validation",
        null,
      );
      await expect(
        validatedBundle(invalid, work.store, validationOwner),
      ).rejects.toThrow();
      await expect(
        loadApp((await content(work.store)).root, work.store, validationOwner),
      ).rejects.toThrow("App");
      await validationOwner.release();
      expect(appSchemaCid.code).toBe(0x71);
      expect(JSON.parse(await readFile(config, "utf8")) as unknown).toEqual(
        work.store.configuration,
      );
    });
  },
);
