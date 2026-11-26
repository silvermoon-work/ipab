import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveViewerSource } from "../src/source.js";

const cid = "bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq";
let folder: string | undefined;
afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
});
it("prefers existing directories to named pins, then pins to CID parsing", async () => {
  folder = await mkdtemp(join(tmpdir(), "ipab-source-"));
  const resolvePin = vi.fn(() => Promise.resolve(cid));
  expect(await resolveViewerSource(folder, { resolvePin })).toEqual({ folder });
  expect(resolvePin).not.toHaveBeenCalled();
  expect(await resolveViewerSource("my-check", { resolvePin })).toEqual({
    contentCid: cid,
  });
  expect(await resolveViewerSource(cid, { resolvePin })).toEqual({
    contentCid: cid,
  });
  expect(resolvePin).toHaveBeenLastCalledWith(cid);
});
it("only falls back on absent directories/pins and does not swallow real failures", async () => {
  const resolvePin = vi.fn(() => Promise.resolve(undefined));
  expect(await resolveViewerSource(cid, { resolvePin })).toEqual({
    contentCid: cid,
  });
  expect(await resolveViewerSource(cid, {})).toEqual({ contentCid: cid });
  await expect(
    resolveViewerSource("missing-source", { resolvePin }),
  ).rejects.toThrow("Unknown viewer");
  await expect(resolveViewerSource("missing-source", {})).rejects.toThrow(
    "requires a host",
  );
  await expect(
    resolveViewerSource("pending", {
      resolvePin: () => Promise.reject(new Error("Pin is pending")),
    }),
  ).rejects.toThrow("Pin is pending");
  await expect(
    resolveViewerSource("invalid-pin", {
      resolvePin: () => Promise.resolve("invalid"),
    }),
  ).rejects.toThrow();
  folder = await mkdtemp(join(tmpdir(), "ipab-source-"));
  const file = join(folder, "file");
  await writeFile(file, "");
  await expect(resolveViewerSource(file, { resolvePin })).rejects.toThrow(
    "not a directory",
  );
  for (const source of ["", "x".repeat(4097)])
    await expect(resolveViewerSource(source, {})).rejects.toThrow("1..4096");
});
