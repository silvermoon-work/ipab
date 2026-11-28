import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderSnapshot } from "../src/folder.js";

let root: string;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ipab-folder-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("local folder snapshot", { tags: ["unit"] }, () => {
  it("reads cached exact bytes, verifies stability and detects atomic saves", async () => {
    await writeFile(join(root, "entry.md"), "one");
    const snapshot = await folderSnapshot(root, signal());
    expect(await new Response(await snapshot.readFile("entry.md")).text()).toBe(
      "one",
    );
    await snapshot.verify();
    await writeFile(join(root, "next.md"), "two");
    await rename(join(root, "next.md"), join(root, "entry.md"));
    expect(await new Response(await snapshot.readFile("entry.md")).text()).toBe(
      "one",
    );
    await expect(snapshot.verify()).rejects.toThrow("changed during loading");
    const updated = await folderSnapshot(root, signal());
    expect(await new Response(await updated.readFile("entry.md")).text()).toBe(
      "two",
    );
  });
  it("rejects unsafe paths, missing files, directories and abort", async () => {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "large.md"), new Uint8Array(1024 * 1024 + 1));
    const snapshot = await folderSnapshot(root, signal());
    for (const path of ["../out.md", "missing.md", "dir"])
      await expect(snapshot.readFile(path)).rejects.toThrow();
    await expect(
      folderSnapshot(join(root, "large.md"), signal()),
    ).rejects.toThrow("real directory");
    const controller = new AbortController();
    const stopped = await folderSnapshot(root, controller.signal);
    controller.abort();
    await expect(stopped.readFile("large.md")).rejects.toThrow();
  });
  it("includes the referenced type file in snapshot stability verification", async () => {
    await writeFile(
      join(root, ".bundle-type.yaml"),
      "contentType: application/json\n",
    );
    const snapshot = await folderSnapshot(root, signal());
    await snapshot.readFile(".bundle-type.yaml");
    await writeFile(
      join(root, ".bundle-type.yaml"),
      "contentType: application/yaml\n",
    );
    await expect(snapshot.verify()).rejects.toThrow("changed during loading");
  });
  it("rejects symbolic links without reading their targets", async () => {
    const target = join(root, "actual");
    await mkdir(target);
    await writeFile(join(target, "entry.md"), "not exposed");
    const link = join(root, "linked");
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(folderSnapshot(link, signal())).rejects.toThrow(
      "symbolic link",
    );
    const snapshot = await folderSnapshot(root, signal());
    await expect(snapshot.readFile("linked/entry.md")).rejects.toThrow(
      "symbolic links",
    );
  });
  it("leaves input size and distinct file limits to the viewer business layer", async () => {
    const snapshot = await folderSnapshot(root, signal());
    for (let index = 0; index < 4; index++) {
      const path = `${index}.md`;
      const bytes = new Uint8Array(1024 * 1024 + 1);
      await writeFile(join(root, path), bytes);
      expect(
        new Uint8Array(
          await new Response(await snapshot.readFile(path)).arrayBuffer(),
        ),
      ).toEqual(bytes);
    }
    const tiny = await folderSnapshot(root, signal());
    for (let index = 0; index < 259; index++) {
      const path = `tiny${index}.md`;
      await writeFile(join(root, path), "");
      expect(await new Response(await tiny.readFile(path)).text()).toBe("");
    }
    await snapshot.verify();
    await tiny.verify();
  });
});
