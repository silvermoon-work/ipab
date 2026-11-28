import {
  createWriter,
  headerLength,
  blockLength,
} from "@ipld/car/buffer-writer";
import * as dagPb from "@ipld/dag-pb";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import type { IpfsStore } from "@ipab/ipfs-store";
import { bundleLimits, openBundle } from "@ipab/bundle";
import { bytes } from "./space.js";
import { HostError } from "./errors.js";
import { publicUrl } from "./config.js";

export async function contentCar(
  store: IpfsStore,
  roots: readonly string[],
): Promise<Uint8Array> {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  let total = 0;
  const visit = async (cid: CID, depth: number): Promise<void> => {
    const key = cid.toV1().toString();
    if (blocks.has(key)) return;
    if (depth > bundleLimits.depth || blocks.size >= bundleLimits.blocks)
      throw new HostError("Publication DAG exceeds limits.");
    const value = await store.block.get(key);
    total += value.length;
    if (total > bundleLimits.bytes)
      throw new HostError("Publication exceeds byte budget.");
    blocks.set(key, { cid, bytes: value });
    if (cid.code === dagPb.code)
      for (const link of dagPb.decode(value).Links)
        await visit(link.Hash, depth + 1);
    else if (cid.code === dagCbor.code) {
      const scan = async (value: unknown): Promise<void> => {
        const link = CID.asCID(value);
        if (link) await visit(link, depth + 1);
        else if (Array.isArray(value))
          for (const item of value) await scan(item);
        else if (value && typeof value === "object")
          for (const item of Object.values(value)) await scan(item);
      };
      await scan(dagCbor.decode(value));
    }
  };
  const cids = [...new Set(roots)].map((root) => CID.parse(root));
  for (const cid of cids) await visit(cid, 0);
  const size =
    headerLength({ roots: cids }) +
    [...blocks.values()].reduce((sum, block) => sum + blockLength(block), 0);
  const writer = createWriter(new ArrayBuffer(size), { roots: cids });
  for (const block of blocks.values()) writer.write(block);
  return writer.close();
}

/** Explicit upload bridge, not a Store backend or daemon lifecycle controller. */
export async function provideContent(
  store: IpfsStore,
  roots: readonly string[],
  endpoint: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(publicUrl(endpoint));
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new HostError(
      "Kubo provider must use HTTPS or account-local loopback HTTP.",
    );
  const car = await contentCar(store, roots);
  const owner = `publication:${roots[0]!}`;
  store.registerOwner(owner, roots);
  await store.retain(owner, roots);
  const data = new FormData();
  data.append("file", new Blob([Uint8Array.from(car)]), "content.car");
  const response = await fetcher(
    `${url.toString().replace(/\/$/, "")}/api/v0/dag/import?pin-roots=true`,
    {
      method: "POST",
      body: data,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok || !response.body)
    throw new HostError(
      `Content provider import failed (HTTP ${response.status}); HEAD was not changed.`,
    );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await bytes(response.body, 256 * 1024),
  );
  const accepted = new Set<string>();
  for (const line of text.trim().split(/\r?\n/)) {
    const item = JSON.parse(line) as {
      Root?: { Cid?: { "/"?: string }; PinErrorMsg?: string };
      ErrMsg?: string;
    };
    if (item.ErrMsg || item.Root?.PinErrorMsg)
      throw new HostError("Content provider failed to pin imported roots.");
    if (item.Root?.Cid?.["/"])
      accepted.add(CID.parse(item.Root.Cid["/"]).toV1().toString());
  }
  if (roots.some((root) => !accepted.has(CID.parse(root).toV1().toString())))
    throw new HostError(
      "Content provider did not confirm every imported/pinned root; HEAD was not changed.",
    );
}

export async function bundleJson(store: IpfsStore, root: string) {
  const bundle = await openBundle(CID.parse(root), {
    resolveCid: (cid) => store.block.get(cid.toString()),
  });
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await bytes(await bundle.readFile(bundle.manifest.entry), 1024 * 1024),
    ),
  );
  return { bundle, value };
}
