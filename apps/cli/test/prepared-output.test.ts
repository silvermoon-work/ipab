import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareApp } from "../src/app-authoring.js";

describe("project preparation replacement safety", { tags: ["unit"] }, () => {
  let root: string, prepared: string;
  beforeEach(async () => {
    await mkdir(resolve(".test-work"), { recursive: true });
    root = await mkdtemp(join(resolve(".test-work"), "prepared-"));
    prepared = join(root, "dist", "prepared-app");
    await mkdir(prepared, { recursive: true });
    await writeFile(join(prepared, ".bundle.yaml"), "preserve");
  });
  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  it("requires explicit replacement and refuses unowned/custom generated output", async () => {
    await expect(prepareApp(root)).rejects.toThrow("replacement");
    await writeFile(
      join(prepared, "ipab.build.yaml"),
      JSON.stringify({ version: 1, files: [], imports: [] }),
    );
    await writeFile(join(prepared, "custom.txt"), "must remain");
    await expect(prepareApp(root, { replace: true })).rejects.toThrow(
      "custom files",
    );
    expect(await readFile(join(prepared, "custom.txt"), "utf8")).toBe(
      "must remain",
    );
  });
  it.each([
    { version: 2, files: [], imports: [] },
    { version: 1, files: {}, imports: [] },
    { version: 1, files: [], imports: ["import"] },
    { version: 1, files: [{ source: "a", target: "b" }], imports: [] },
    {
      version: 1,
      files: [{ source: "../outside", target: "../outside" }],
      imports: [],
    },
  ])(
    "rejects invalid prepared ownership recipe %# without deleting content",
    async (recipe) => {
      await writeFile(
        join(prepared, "ipab.build.yaml"),
        JSON.stringify(recipe),
      );
      await expect(prepareApp(root, { replace: true })).rejects.toThrow();
      expect(await readFile(join(prepared, ".bundle.yaml"), "utf8")).toBe(
        "preserve",
      );
    },
  );
  it("checks nested generated files and removes only verified output before reporting a missing project", async () => {
    await mkdir(join(prepared, "resources"));
    await writeFile(join(prepared, "resources", "app.cjs"), "generated");
    await writeFile(
      join(prepared, "ipab.build.yaml"),
      JSON.stringify({
        version: 1,
        files: [{ source: "resources/app.cjs", target: "resources/app.cjs" }],
        imports: [],
      }),
    );
    await expect(prepareApp(root, { replace: true })).rejects.toThrow(
      "configuration",
    );
    await expect(
      readFile(join(prepared, "resources", "app.cjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not replace a symlinked output directory", async () => {
    await rm(prepared, { recursive: true });
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "keep"), "owned elsewhere");
    await symlink(
      external,
      prepared,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(prepareApp(root, { replace: true })).rejects.toThrow(
      "regular",
    );
    expect(await readFile(join(external, "keep"), "utf8")).toBe(
      "owned elsewhere",
    );
  });
});
