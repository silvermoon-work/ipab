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
describe("bounded local folder snapshot", () => {
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
  it("rejects unsafe paths, missing files, directories, large files and abort", async () => {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "large.md"), new Uint8Array(1024 * 1024 + 1));
    const snapshot = await folderSnapshot(root, signal());
    for (const path of ["../out.md", "missing.md", "dir", "large.md"])
      await expect(snapshot.readFile(path)).rejects.toThrow();
    await expect(
      folderSnapshot(join(root, "large.md"), signal()),
    ).rejects.toThrow("real directory");
    const controller = new AbortController();
    const stopped = await folderSnapshot(root, controller.signal);
    controller.abort();
    await expect(stopped.readFile("large.md")).rejects.toThrow();
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
  it("limits aggregate bytes and distinct file count", async () => {
    const snapshot = await folderSnapshot(root, signal());
    for (let index = 0; index < 4; index++) {
      const path = `${index}.md`;
      await writeFile(join(root, path), new Uint8Array(1024 * 1024));
      if (index < 3) await snapshot.readFile(path);
      else await expect(snapshot.readFile(path)).rejects.toThrow("3 MiB");
    }
    const tiny = await folderSnapshot(root, signal());
    for (let index = 0; index < 259; index++) {
      const path = `tiny${index}.md`;
      await writeFile(join(root, path), "");
      if (index < 258) await tiny.readFile(path);
      else await expect(tiny.readFile(path)).rejects.toThrow("258 input files");
    }
  });
});
