import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { expect, test, vi } from "vitest";
import { createIpfsGatewayClient } from "../src/index.js";

const { onLoad, createNode } = vi.hoisted(() => ({
  onLoad: vi.fn<() => void>(),
  createNode: vi.fn(() => {
    throw new Error("A canceled read must not start a gateway node.");
  }),
}));
vi.mock("@helia/http", () => {
  onLoad();
  return { createHeliaHTTP: createNode };
});

test(
  "loads the gateway on demand and honors cancellation during import",
  { tags: ["mock"] },
  async () => {
    const client = createIpfsGatewayClient("http://127.0.0.1:1");
    const cid = CID.createV1(0x55, await sha256.digest(new Uint8Array()));
    const controller = new AbortController();
    const reason = new Error("Canceled during gateway load.");
    onLoad.mockImplementationOnce(() => {
      controller.abort(reason);
    });
    try {
      expect(onLoad).not.toHaveBeenCalled();
      await expect(
        client.block.get(cid.toString(), { signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(onLoad).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
    expect(createNode).not.toHaveBeenCalled();
  },
);
