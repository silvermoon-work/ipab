import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBundleViewer, type RunBundleViewerOptions } from "../src/index.js";

const definition = {
  name: "Message",
  description: "",
  entry: {
    path: "message.json",
    contentType: "application/json",
    schema: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
    },
  },
};
const page =
  '<div id="ipab-viewer"><!--ipab:viewer--></div><!--ipab:state--><script type="module" src="./app.js"></script>';
const encode = (source: string) => new TextEncoder().encode(source);
const running: { controller: AbortController; finished: Promise<void> }[] = [];
afterEach(async () => {
  for (const run of running.splice(0)) {
    run.controller.abort();
    await expect(run.finished).rejects.toThrow("cancelled");
  }
});
function options(
  files = new Map([
    [".bundle.yaml", encode(JSON.stringify(definition))],
    ["message.json", encode('{"message":"Real content"}')],
    ["resources/web/index.html", encode(page)],
  ]),
): RunBundleViewerOptions {
  return {
    schema: definition,
    contentCid: "content",
    context: {
      appCid: "app",
      readFile(cid, path, { signal } = {}) {
        signal?.throwIfAborted();
        expect(cid).toBe(path.startsWith("resources/") ? "app" : "content");
        const bytes = files.get(path);
        if (!bytes) throw new Error(`Missing ${path}`);
        return Promise.resolve(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        );
      },
    },
    frontendRoot: "resources/web",
    openBrowser: false,
    viewer({ data }) {
      return createElement("h1", null, JSON.stringify(data));
    },
  };
}
async function start(overrides: Partial<RunBundleViewerOptions> = {}) {
  const controller = new AbortController();
  let ready!: (url: string) => void;
  const urlPromise = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const diagnostics: string[] = [];
  const finished = runBundleViewer({
    ...options(),
    ...overrides,
    signal: controller.signal,
    onDiagnostic(message) {
      diagnostics.push(message);
      const url = message.match(/http:\/\/[^ ]+/)?.[0];
      if (url) ready(url);
    },
  });
  void finished.catch(() => {});
  running.push({ controller, finished });
  const url = await urlPromise;
  return { url, diagnostics };
}

describe("React Content Bundle server", () => {
  it("requires exactly one explicit content source", async () => {
    const configured = options();
    const withoutCid = { ...configured };
    delete withoutCid.contentCid;
    await expect(runBundleViewer(withoutCid)).rejects.toThrow("exactly one");
    await expect(
      runBundleViewer({ ...configured, folder: "." }),
    ).rejects.toThrow("exactly one");
    await expect(
      runBundleViewer({ ...configured, source: "." }),
    ).rejects.toThrow("cannot be combined");
  });
  it("prepares resource-backed data once before SSR and uses the same resolved state", async () => {
    const prepareData = vi.fn(
      async (
        _data: unknown,
        context: {
          signal: AbortSignal;
          readFile(path: string): Promise<ReadableStream<Uint8Array>>;
        },
      ) => {
        context.signal.throwIfAborted();
        await context.readFile("message.json");
        return { message: "Resolved Markdown" };
      },
    );
    const app = await start({ prepareData });
    for (let index = 0; index < 2; index++) {
      const html = await fetch(new URL("frame/index.html", app.url)).then(
        (response) => response.text(),
      );
      expect(html).toContain("Resolved Markdown");
      expect(html).not.toContain("Real content");
    }
    expect(prepareData).toHaveBeenCalledTimes(1);
  });
  it("fails resource preparation explicitly before starting the server", async () => {
    await expect(
      runBundleViewer({
        ...options(),
        prepareData: () => Promise.reject(new Error("Missing instructions")),
      }),
    ).rejects.toThrow("Missing instructions");
  });
  it("renders actual content in HTTP HTML before any browser connection", async () => {
    const app = await start();
    const response = await fetch(new URL("frame/index.html", app.url));
    const html = await response.text();
    expect(html).toContain("<h1>");
    expect(html).toContain("Real content");
    expect(html).not.toContain("<!--ipab:");
    expect(html).toContain(
      'type="application/json">{"message":"Real content"}',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'none'",
    );
  });
  it("preserves large content outside the RPC budget and escapes state markup", async () => {
    const message = "</script><script>alert(1)</script>&>" + "x".repeat(65_536);
    const configured = options(
      new Map([
        [".bundle.yaml", encode(JSON.stringify(definition))],
        ["message.json", encode(JSON.stringify({ message }))],
        ["resources/web/index.html", encode(page)],
      ]),
    );
    const app = await start(configured);
    const html = await fetch(new URL("frame/index.html", app.url)).then(
      (response) => response.text(),
    );
    const source = /type="application\/json">([^<]+)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(source) as unknown).toEqual({ message });
    expect(source).toContain("\\u003c/script\\u003e");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
  it.each([
    [".bundle.yaml", '{"name":"Wrong"}', "Invalid"],
    [
      ".bundle.yaml",
      JSON.stringify({ ...definition, name: "Other" }),
      "does not match",
    ],
    ["message.json", '{"message":12}', "must be string"],
    ["message.json", new Uint8Array([255]), "Invalid"],
    ["message.json", "x".repeat(1024 * 1024 + 1), "exceeds 1 MiB"],
  ])("rejects invalid %s before starting HTTP", async (path, value, error) => {
    const files = new Map([
      [".bundle.yaml", encode(JSON.stringify(definition))],
      ["message.json", encode('{"message":"Real content"}')],
    ]);
    files.set(path, typeof value === "string" ? encode(value) : value);
    await expect(runBundleViewer(options(files))).rejects.toThrow(error);
  });
  it("honours cancellation while loading, including cleanup failure", async () => {
    const controller = new AbortController();
    const configured = options();
    configured.context.readFile = () =>
      Promise.resolve(
        new ReadableStream({
          pull() {
            setTimeout(() => {
              controller.abort();
            }, 0);
          },
          cancel() {
            throw new Error("Stream cleanup failed");
          },
        }),
      );
    await expect(
      runBundleViewer({ ...configured, signal: controller.signal }),
    ).rejects.toThrow("Stream cleanup failed");
  });
  it("rejects cancelled startup before reading content", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runBundleViewer({ ...options(), signal: controller.signal }),
    ).rejects.toThrow();
  });
  it("enforces expanded state and structural validation budgets", async () => {
    const yamlDefinition = {
      ...definition,
      entry: { ...definition.entry, contentType: "application/yaml" },
    };
    const yaml = options(
      new Map([
        [".bundle.yaml", encode(JSON.stringify(yamlDefinition))],
        ["message.json", encode(`message: |\n  ${"\t".repeat(530_000)}\n`)],
      ]),
    );
    yaml.schema = yamlDefinition;
    await expect(runBundleViewer(yaml)).rejects.toThrow(
      "Viewer state exceeds 1 MiB",
    );
    const arrayDefinition = {
      ...definition,
      entry: {
        path: "message.json",
        contentType: "application/json",
        schema: {
          type: "array",
          items: { anyOf: [{ type: "number" }, { type: "string" }] },
        },
      },
    };
    const array = options(
      new Map([
        [".bundle.yaml", encode(JSON.stringify(arrayDefinition))],
        [
          "message.json",
          encode(JSON.stringify(Array<string>(60_000).fill("a"))),
        ],
      ]),
    );
    array.schema = arrayDefinition;
    await expect(runBundleViewer(array)).rejects.toMatchObject({
      cause: { message: "Viewer validation budget exceeded" },
    });
  });
  it.each(["missing markers", "duplicate markers", "render failure"])(
    "reports %s as HTTP failure, not a successful shell",
    async (failure) => {
      const configured = options(
        new Map([
          [".bundle.yaml", encode(JSON.stringify(definition))],
          ["message.json", encode('{"message":"Real content"}')],
          [
            "resources/web/index.html",
            encode(
              failure === "missing markers"
                ? "<main></main>"
                : failure === "duplicate markers"
                  ? page + page
                  : page,
            ),
          ],
        ]),
      );
      if (failure === "render failure")
        configured.viewer = () => {
          throw new Error("Viewer rejected content");
        };
      const app = await start(configured);
      const response = await fetch(new URL("frame/index.html", app.url));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: "RenderFailed" },
      });
      expect(app.diagnostics.at(-1)).toContain("Frontend rendering failed");
    },
  );
  it("propagates read failures without inventing default content", async () => {
    const configured = options();
    configured.context.readFile = vi
      .fn()
      .mockRejectedValue(new Error("Content unavailable"));
    await expect(runBundleViewer(configured)).rejects.toThrow(
      "Content unavailable",
    );
  });
});
