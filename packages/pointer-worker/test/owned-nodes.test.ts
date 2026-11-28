import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedNodes } from "./owned-nodes.ts";

describe("owned-node cleanup inventory", { tags: ["unit"] }, () => {
  it("permits an absent registry only before any managed node has been discovered", async () => {
    const base = resolve(".test-work");
    await mkdir(base, { recursive: true });
    const state = await mkdtemp(join(base, "owned-records-"));
    try {
      expect(await ownedNodes(state, true)).toEqual([]);
      await expect(ownedNodes(state, false)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
  it("never converts missing or corrupt individual records into an empty cleanup list", async () => {
    const base = resolve(".test-work");
    await mkdir(base, { recursive: true });
    const state = await mkdtemp(join(base, "owned-records-"));
    const directory = join(state, "swarm-nodes", "scope");
    try {
      await mkdir(directory, { recursive: true });
      await expect(ownedNodes(state, true)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await writeFile(join(directory, "node.json"), "{");
      await expect(ownedNodes(state, true)).rejects.toThrow();
      await writeFile(
        join(directory, "node.json"),
        JSON.stringify({
          api: "bad",
          peerId: "peer",
          auth: "secret",
          swarm: 4001,
        }),
      );
      await expect(ownedNodes(state, true)).rejects.toThrow(
        "Invalid owned node record",
      );
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
});
