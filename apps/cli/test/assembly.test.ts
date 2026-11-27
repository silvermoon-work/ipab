import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CarBlockIterator } from "@ipld/car/iterator";
import {
  encodeBundleCar,
  memoryTree,
  streamChunks,
} from "@ipab/bundle-builder";
import { openBundle } from "@ipab/bundle";
import { assembleBundle } from "../src/assembly.js";
import { readCar } from "../src/authoring.js";

describe("generic assembly recipes", { tags: ["unit"] }, () => {
  const definition = {
    name: "Assembly",
    entry: {
      path: "entry.json",
      contentType: "application/json",
      schema: { type: "object" },
    },
  };
  const recipe = {
    version: 1,
    files: [{ source: "input.json", target: "entry.json" }],
    imports: [],
  };
  let work: string;
  beforeEach(async () => {
    await mkdir(resolve(".test-work"), { recursive: true });
    work = await mkdtemp(join(resolve(".test-work"), "assembly-"));
    await writeFile(join(work, ".bundle.yaml"), JSON.stringify(definition));
    await writeFile(join(work, "input.json"), '{"text":"prepared"}');
    await writeFile(join(work, "ipab.build.yaml"), JSON.stringify(recipe));
  });
  afterEach(async () => {
    await rm(work, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  it("assembles an explicit recipe file without compiling or overwriting selected inputs", async () => {
    const result = await assembleBundle(join(work, "ipab.build.yaml"));
    expect(result.output).toBe(join(work, "dist", "bundle.car"));
    const car = await readCar(result.output, {});
    const bundle = await openBundle(car.root, { resolveCid: car.resolveCid });
    expect(await new Response(await bundle.readFile("entry.json")).text()).toBe(
      '{"text":"prepared"}',
    );
    await expect(assembleBundle(work)).rejects.toThrow("already exists");
    await expect(
      assembleBundle(work, { output: join(work, "input.json"), replace: true }),
    ).rejects.toThrow("replace");
    await expect(
      assembleBundle(work, {
        output: join(work, ".bundle.yaml"),
        replace: true,
      }),
    ).rejects.toThrow("replace");
  });
  it.each([
    { version: 2, files: [] },
    { version: 1, files: "all" },
    { version: 1, files: [], hooks: "never" },
    { version: 1, files: [{ source: "input.json" }] },
    {
      version: 1,
      files: [{ source: "input.json", target: "entry.json", extra: true }],
    },
    {
      version: 1,
      files: [
        { source: "input.json", target: "entry.json" },
        { source: "input.json", target: "ENTRY.JSON" },
      ],
    },
    { version: 1, files: [{ source: "input.json", target: ".bundle.yaml" }] },
    { version: 1, files: [{ source: "../input.json", target: "entry.json" }] },
    { version: 1, files: [], imports: [] },
    {
      version: 1,
      files: recipe.files,
      imports: [{ cid: 1, target: "resources/import" }],
    },
    {
      version: 1,
      files: recipe.files,
      imports: [{ cid: "ipab:///somewhere", target: "resources/import" }],
    },
  ])("rejects unsafe, ambiguous or incomplete recipe %#", async (value) => {
    await writeFile(join(work, "ipab.build.yaml"), JSON.stringify(value));
    await expect(assembleBundle(work)).rejects.toThrow();
  });
  it("requires explicit CID resolution and includes an original verified imported DAG", async () => {
    const encoded = await encodeBundleCar(
      memoryTree(
        new Map([
          [
            ".bundle.yaml",
            new TextEncoder().encode(JSON.stringify(definition)),
          ],
          ["entry.json", new TextEncoder().encode('{"original":true}')],
        ]),
      ),
    );
    const cid = encoded.cid;
    const blocks = new Map<string, Uint8Array>();
    try {
      const car = await CarBlockIterator.fromIterable(
        streamChunks(encoded.stream),
      );
      for await (const block of car)
        blocks.set(block.cid.toString(), block.bytes);
    } finally {
      await encoded.close();
    }
    await writeFile(
      join(work, "ipab.build.yaml"),
      JSON.stringify({
        ...recipe,
        imports: [{ cid: cid.toString(), target: "resources/original" }],
      }),
    );
    await expect(assembleBundle(work)).rejects.toThrow("require a Store");
    const result = await assembleBundle(work, {
      resolveCid: (cid) => {
        const bytes = blocks.get(cid.toString());
        if (!bytes) return Promise.reject(new Error("Missing import"));
        return Promise.resolve(bytes);
      },
    });
    const car = await readCar(result.output, {});
    expect(car.blocks.get(cid.toString())).toEqual(blocks.get(cid.toString()));
    const bundle = await openBundle(car.root, { resolveCid: car.resolveCid });
    expect(
      await new Response(
        await bundle.readFile("resources/original/entry.json"),
      ).text(),
    ).toBe('{"original":true}');
  });
  it("rejects old App-only configuration, missing selected content and symlink roots", async () => {
    await rm(join(work, "ipab.build.yaml"));
    await writeFile(
      join(work, "ipab.yaml"),
      "entry: src/main.ts\nresources: []\n",
    );
    await expect(assembleBundle(work)).rejects.toThrow("Legacy App");
    await writeFile(join(work, "ipab.build.yaml"), JSON.stringify(recipe));
    await rm(join(work, "input.json"));
    await expect(assembleBundle(work)).rejects.toThrow();
    const linked = join(work, "linked");
    await symlink(
      work,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(assembleBundle(linked)).rejects.toThrow("symlink");
  });
  it("grafts a local CAR without a Store and rejects a different declared CID", async () => {
    const input = await assembleBundle(work, {
      output: join(work, "input.car"),
    });
    const fromCar = (cid: string) =>
      writeFile(
        join(work, "ipab.build.yaml"),
        JSON.stringify({
          ...recipe,
          imports: [{ cid, target: "original", car: "input.car" }],
        }),
      );
    await fromCar(input.cid);
    const result = await assembleBundle(work);
    const car = await readCar(result.output, {});
    const bundle = await openBundle(car.root, { resolveCid: car.resolveCid });
    expect(
      await new Response(await bundle.readFile("original/entry.json")).text(),
    ).toBe('{"text":"prepared"}');
    await fromCar(result.cid);
    await expect(assembleBundle(work, { replace: true })).rejects.toThrow(
      "local CAR root",
    );
  });
});
