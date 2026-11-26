import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { runBundleViewer } from "../src/index.js";

let folder: string;
let controller: AbortController | undefined;
let finished: Promise<void> | undefined;
afterEach(async () => {
  controller?.abort();
  if (finished) await expect(finished).rejects.toThrow("cancelled");
  if (folder) await rm(folder, { recursive: true, force: true });
});
it.each(["valid", "invalid"])(
  "updates local Markdown from %s startup without rebuilding, hides invalid edits and recovers",
  { tags: ["release-e2e"], timeout: 15_000 },
  async (initial) => {
    folder = await mkdtemp(join(tmpdir(), "ipab-watch-"));
    const schema = {
      name: "Watch",
      description: "",
      entry: {
        path: "entry.json",
        contentType: "application/json",
        schema: { type: "object" },
      },
    };
    await writeFile(join(folder, ".bundle.yaml"), JSON.stringify(schema));
    await writeFile(
      join(folder, "entry.json"),
      initial === "invalid" ? "{" : "{}",
    );
    await writeFile(join(folder, "instructions.md"), "Initial");
    controller = new AbortController();
    let ready!: (url: string) => void;
    const urlPromise = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const diagnostic = vi.fn((message: string) => {
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(message)?.[0];
      if (url) ready(url);
    });
    finished = runBundleViewer({
      source: folder,
      schema,
      context: {
        appCid: "app",
        readFile: () =>
          Promise.resolve(
            new ReadableStream({
              start(stream) {
                stream.enqueue(
                  new TextEncoder().encode(
                    '<div id="ipab-viewer"><!--ipab:viewer--></div><!--ipab:state-->',
                  ),
                );
                stream.close();
              },
            }),
          ),
      },
      viewer: ({ data }) => createElement("h1", null, String(data)),
      prepareData: async (_data, context) =>
        new Response(await context.readFile("instructions.md")).text(),
      frontendRoot: "web",
      openBrowser: false,
      signal: controller.signal,
      onDiagnostic: diagnostic,
    });
    void finished.catch(() => {});
    const url = await urlPromise;
    const host = await fetch(url).then((response) => response.text());
    const secret = /nonce="([^"]+)"/.exec(host)![1]!;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(new URL(path, url), {
        method: "POST",
        headers: {
          Origin: new URL(url).origin,
          "X-IPAB-Web": secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<Record<string, unknown>>;
    };
    const session = (await post("/session", {})).session;
    const call = async (method: string, input: unknown) => {
      const response = await post("/call", {
        session,
        id: "watch",
        method,
        input,
      });
      return response.value as Record<string, unknown> | string;
    };
    if (initial === "invalid") {
      const html = await fetch(new URL("frame/index.html", url)).then(
        (response) => response.text(),
      );
      expect(html).toContain("Folder preview invalid");
      expect(html).not.toContain("<h1>");
      await writeFile(join(folder, "entry.json"), "{}");
      await vi.waitFor(
        async () => {
          const recovered = (await call("viewerRevision", {})) as Record<
            string,
            unknown
          >;
          expect(recovered.error).toBe("");
        },
        { timeout: 5000, interval: 300 },
      );
    }
    const first = (await call("viewerRevision", {})) as Record<string, unknown>;
    expect(
      await fetch(new URL("frame/index.html", url)).then((response) =>
        response.text(),
      ),
    ).toContain("<h1>Initial</h1>");
    await writeFile(join(folder, "next.md"), "Updated".repeat(15_000));
    await rename(join(folder, "next.md"), join(folder, "instructions.md"));
    let updated: Record<string, unknown> = first;
    await vi.waitFor(
      async () => {
        updated = (await call("viewerRevision", {})) as Record<string, unknown>;
        expect(updated.revision).not.toBe(first.revision);
      },
      { timeout: 5000, interval: 300 },
    );
    expect(updated.chunks).toBeGreaterThan(1);
    let data = "";
    for (let index = 0; index < Number(updated.chunks); index++) {
      const chunk = await call("viewerChunk", {
        revision: updated.revision,
        index,
      });
      if (typeof chunk !== "string") throw new Error("Expected viewer chunk");
      data += chunk;
    }
    expect(JSON.parse(data) as unknown).toBe("Updated".repeat(15_000));
    const rejected = await post("/call", {
      session,
      id: "bad",
      method: "viewerChunk",
      input: { revision: first.revision, index: 0 },
    });
    expect(rejected.type).toBe("error");
    await writeFile(join(folder, "entry.json"), "{");
    await vi.waitFor(
      async () => {
        const invalid = (await call("viewerRevision", {})) as Record<
          string,
          unknown
        >;
        expect(invalid.error).toContain("Folder preview invalid");
      },
      { timeout: 5000, interval: 300 },
    );
    const broken = await fetch(new URL("frame/index.html", url)).then(
      (response) => response.text(),
    );
    expect(broken).not.toContain("<h1>");
    expect(broken).toContain("Folder preview invalid");
    await writeFile(join(folder, "entry.json"), "{}");
    await vi.waitFor(
      async () => {
        const recovered = (await call("viewerRevision", {})) as Record<
          string,
          unknown
        >;
        expect(recovered.error).toBe("");
      },
      { timeout: 5000, interval: 300 },
    );
  },
);
