import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test, type TestContext } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  createIpfsGatewayClient,
  GatewayReadError,
  withGatewayHints,
} from "../src/index.js";

const bytes = Buffer.from("verified content, independent of source");
const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString();
async function source(
  t: TestContext,
  name: string,
  order: string[],
  blocks?: ReadonlyMap<string, Uint8Array>,
) {
  let mode = "ok";
  const server = createServer((request, response) => {
    order.push(name);
    const target = new URL(request.url!, "http://localhost");
    const key = target.pathname.split("/").at(-1)!;
    assert.equal(request.url, `/ipfs/${blocks ? key : cid}?format=raw`);
    assert.equal(request.headers.accept, "application/vnd.ipld.raw");
    if (mode === "stall") {
      response.writeHead(200, { "content-type": "application/vnd.ipld.raw" });
      response.flushHeaders();
    } else if (mode === "redirect") {
      response
        .writeHead(302, { location: "http://127.0.0.1:1/untrusted" })
        .end();
    } else {
      response
        .writeHead(mode === "missing" ? 404 : 200, {
          "content-type": "application/vnd.ipld.raw",
        })
        .end(
          mode === "bad"
            ? Buffer.from("corrupt")
            : blocks
              ? blocks.get(key)
              : bytes,
        );
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.onTestFinished(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    mode(value: string) {
      mode = value;
    },
  };
}
test(
  "ordered sources retry HTTP, redirect and CID failures without changing content identity",
  { tags: ["release-e2e"] },
  async (t) => {
    const order: string[] = [];
    const first = await source(t, "first", order);
    const second = await source(t, "second", order);
    const third = await source(t, "third", order);
    const client = createIpfsGatewayClient([first.url, second.url, third.url]);
    for (const mode of ["missing", "bad", "redirect", "ok"]) {
      first.mode(mode);
      order.length = 0;
      assert.deepEqual(await client.block.get(cid), bytes);
      assert.deepEqual(order, mode === "ok" ? ["first"] : ["first", "second"]);
    }
    first.mode("bad");
    second.mode("missing");
    third.mode("bad");
    await assert.rejects(client.block.get(cid), (error: unknown) => {
      assert.ok(error instanceof GatewayReadError);
      assert.equal(error.budgetExhausted, false);
      assert.deepEqual(
        error.attempts.map(({ source }) => source),
        [`${first.url}/`, `${second.url}/`, `${third.url}/`],
      );
      assert.ok(
        error.attempts.every(
          ({ outcome }) => outcome === "read_or_verification_failed",
        ),
      );
      assert.match(error.message, /read_or_verification_failed/);
      assert.doesNotMatch(error.message, /corrupt/);
      return true;
    });
  },
);
test(
  "owned Gateway close seals reads and awaits aborted per-read resources",
  { tags: ["release-e2e"] },
  async (t) => {
    const order: string[] = [];
    const gateway = await source(t, "owned", order);
    gateway.mode("stall");
    const client = createIpfsGatewayClient(gateway.url, { timeoutMs: 2000 });
    const read = client.block.get(cid);
    const rejected = assert.rejects(read, /Gateway client is closing/);
    const end = Date.now() + 2000;
    while (!order.length) {
      assert.ok(Date.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(client.close(), client.close());
    await client.close();
    await rejected;
    await assert.rejects(client.block.get(cid), /Gateway client is closing/);
  },
);
test(
  "per-attempt timeout leaves a backup opportunity; total budget and cancellation stop failover",
  { tags: ["release-e2e"] },
  async (t) => {
    const order: string[] = [];
    const first = await source(t, "first", order);
    const second = await source(t, "second", order);
    const third = await source(t, "third", order);
    first.mode("stall");
    assert.deepEqual(
      await createIpfsGatewayClient([first.url, second.url], {
        timeoutMs: 2000,
        attemptTimeoutMs: 200,
      }).block.get(cid),
      bytes,
    );
    assert.deepEqual(order, ["first", "second"]);
    second.mode("stall");
    order.length = 0;
    const started = performance.now();
    await assert.rejects(
      createIpfsGatewayClient([first.url, second.url, third.url], {
        timeoutMs: 400,
        attemptTimeoutMs: 250,
      }).block.get(cid),
      (error: unknown) => {
        assert.ok(error instanceof GatewayReadError);
        assert.equal(error.budgetExhausted, true);
        assert.ok(error.attempts.every(({ outcome }) => outcome === "timeout"));
        return true;
      },
    );
    assert.ok(performance.now() - started < 2000);
    assert.equal(order.includes("third"), false);
    order.length = 0;
    const controller = new AbortController();
    const canceled = createIpfsGatewayClient([first.url, third.url]).block.get(
      cid,
      {
        signal: controller.signal,
      },
    );
    const deadline = Date.now() + 2000;
    while (!order.length && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 5));
    assert.deepEqual(order, ["first"]);
    controller.abort(new Error("host canceled"));
    await assert.rejects(canceled, /host canceled/);
    assert.deepEqual(order, ["first"]);
    await assert.rejects(
      createIpfsGatewayClient(third.url).block.get(cid, {
        signal: controller.signal,
      }),
      /host canceled/,
    );
    assert.deepEqual(order, ["first"]);
  },
);
test(
  "garbage collection cannot discard the per-attempt failover deadline",
  { tags: ["release-e2e"] },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict";
        import { createServer } from "node:http";
        import { createIpfsGatewayClient } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
        const bytes = Buffer.from(${JSON.stringify(bytes.toString())});
        const order = [];
        const server = createServer((request, response) => {
          order.push(request.url.split("/")[1]);
          response.writeHead(200, { "content-type": "application/vnd.ipld.raw" });
          if (request.url.startsWith("/backup/")) response.end(bytes);
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const base = "http://127.0.0.1:" + server.address().port;
        const client = createIpfsGatewayClient([base + "/first", base + "/backup"], {
          allowPath: true, timeoutMs: 2000, attemptTimeoutMs: 200,
        });
        const gcTimer = setInterval(() => global.gc(), 10);
        try {
          assert.deepEqual(await client.block.get(${JSON.stringify(cid)}), bytes);
          assert.deepEqual(order, ["first", "backup"]);
        } finally {
          clearInterval(gcTimer);
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
          await client.close();
        }
      `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  },
);
test(
  "only explicit hint policy permits network access, after trusted sources and within their budget",
  { tags: ["release-e2e"] },
  async (t) => {
    const order: string[] = [];
    const first = await source(t, "first", order);
    const hint = await source(t, "hint", order);
    first.mode("missing");
    const primary = createIpfsGatewayClient(first.url);
    await assert.rejects(withGatewayHints(primary, [hint.url]).block.get(cid));
    assert.deepEqual(order, ["first"]);
    order.length = 0;
    const policy: string[] = [];
    assert.deepEqual(
      await withGatewayHints(primary, [hint.url], (target) => {
        policy.push(target.href);
        return target.origin === hint.url;
      }).block.get(cid),
      bytes,
    );
    assert.deepEqual(order, ["first", "hint"]);
    assert.deepEqual(policy, [`${hint.url}/ipfs/${cid}?format=raw`]);
    order.length = 0;
    first.mode("stall");
    const bounded = createIpfsGatewayClient(first.url, {
      timeoutMs: 150,
      attemptTimeoutMs: 1000,
    });
    await assert.rejects(
      withGatewayHints(bounded, [hint.url], () => true).block.get(cid),
    );
    assert.equal(
      order.includes("hint"),
      false,
      "Hints do not start a second timeout budget.",
    );
  },
);
test(
  "single-source calls remain valid and invalid/duplicate lists fail before network access",
  { tags: ["unit"] },
  () => {
    assert.ok(createIpfsGatewayClient("https://example.test"));
    for (const urls of [
      [],
      Array(17).fill("https://example.test"),
      ["https://example.test", "https://example.test/"],
      ["https://example.test/path"],
      ["https://example.test/?"],
      ["https://example.test/#"],
    ])
      assert.throws(() => createIpfsGatewayClient(urls));
    for (const options of [
      { timeoutMs: 0 },
      { attemptTimeoutMs: -1 },
      { timeoutMs: 2_147_483_648 },
    ])
      assert.throws(() =>
        createIpfsGatewayClient("https://example.test", options),
      );
  },
);
