import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpfsStore } from "@ipab/ipfs-store";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";
import { CarBlockIterator } from "@ipld/car/iterator";
import { contentCar, provideContent } from "../src/content-provider.js";

describe("selected-node CAR publication", { tags: ["mock"] }, () => {
  let store: IpfsStore, root: string;
  let retainCalls: number;
  beforeEach(async () => {
    store = IpfsStore.fromClient({
      block: { get: () => Promise.reject(new Error("missing")) },
    });
    vi.spyOn(store, "registerOwner").mockImplementation(() => {});
    retainCalls = 0;
    vi.spyOn(store, "retain").mockImplementation(() => {
      retainCalls++;
      return Promise.resolve();
    });
    const bytes = new TextEncoder().encode("private network payload");
    const cid = CID.createV1(0x55, await sha256.digest(bytes));
    await store.put(cid, bytes);
    root = cid.toString();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
  });
  it("publishes all distinct roots with or without a protected node token and requires every pin acknowledgment", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        new Response(
          JSON.stringify({ Root: { Cid: { "/": root }, PinErrorMsg: "" } }),
        ),
      );
    };
    await provideContent(store, [root], "https://node.example", fetcher);
    expect(requests[0]!.headers.has("authorization")).toBe(false);
    await provideContent(
      store,
      [root],
      "http://127.0.0.1:55001",
      fetcher,
      "account-local-secret",
    );
    expect(requests[1]!.headers.get("authorization")).toBe(
      "Bearer account-local-secret",
    );
    expect(retainCalls).toBe(2);
    await expect(
      provideContent(store, [root], "http://10.0.0.1:5001", fetcher),
    ).rejects.toThrow("HTTPS");
  });
  it("does not confirm publication after import rejection, missing response, failed pins, malformed output or incomplete root acknowledgments", async () => {
    for (const response of [
      new Response("unavailable", { status: 503 }),
      new Response(null),
      new Response(JSON.stringify({ ErrMsg: "disk full" })),
      new Response(JSON.stringify({ Root: { PinErrorMsg: "cannot pin" } })),
      new Response("not JSON"),
      new Response(JSON.stringify({ Root: {} })),
    ])
      await expect(
        provideContent(store, [root], "http://127.0.0.1:5001", () =>
          Promise.resolve(response),
        ),
      ).rejects.toThrow();
  });
  it("walks nested linked data and deduplicates roots without treating ordinary values as dependencies", async () => {
    const bytes = dagCbor.encode({
      nested: [
        { link: CID.parse(root) },
        CID.parse(root),
        {},
        null,
        false,
        "not a CID link",
      ],
    });
    const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
    await store.put(cid, bytes);
    const car = await CarBlockIterator.fromBytes(
      await contentCar(store, [cid.toString(), cid.toString()]),
    );
    expect((await car.getRoots()).map((value) => value.toString())).toEqual([
      cid.toString(),
    ]);
    const blocks: string[] = [];
    for await (const block of car) blocks.push(block.cid.toString());
    expect(blocks).toEqual(expect.arrayContaining([root, cid.toString()]));
    expect(blocks).toHaveLength(2);
  });
});
