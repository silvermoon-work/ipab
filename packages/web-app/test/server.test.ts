import { request as httpRequest } from "node:http";
import * as processes from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineWebAppMethod,
  runWebApp,
  type JsonValue,
  type RunWebAppOptions,
  type WebAppMethod,
} from "../src/index.js";

vi.mock("node:child_process", async () => {
  const original =
    await vi.importActual<typeof processes>("node:child_process");
  return {
    ...original,
    spawn: vi.fn(() =>
      original.spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
    ),
  };
});

const running: { controller: AbortController; finished: Promise<void> }[] = [];
const argv = process.argv;
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;
afterEach(async () => {
  for (const run of running.splice(0)) {
    run.controller.abort();
    await run.finished.catch(() => {});
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(processes.spawn).mockReset();
  Object.defineProperty(process, "platform", platformDescriptor);
  process.argv = argv;
});

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
const echo = defineWebAppMethod({
  request: { parse: string },
  response: { parse: string },
  handle(input, { emit }) {
    emit("greeting", input);
    return input;
  },
});

async function start(overrides: Partial<RunWebAppOptions> = {}) {
  const controller = new AbortController();
  const paths: string[] = [];
  let ready!: (value: string) => void;
  const urlPromise = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const finished = runWebApp({
    context: {
      appCid: "app-cid",
      readFile(cid, path) {
        expect(cid).toBe("app-cid");
        paths.push(path);
        if (path.endsWith("missing.js"))
          return Promise.reject(new Error("Missing"));
        return Promise.resolve(
          new ReadableStream({
            start(stream) {
              stream.enqueue(
                new TextEncoder().encode(
                  path.endsWith("index.html")
                    ? '<script type="module" src="./assets/app.js"></script>'
                    : "export const x=1",
                ),
              );
              stream.close();
            },
          }),
        );
      },
    },
    frontendRoot: "resources/web",
    openBrowser: false,
    handlers: { echo },
    signal: controller.signal,
    ...overrides,
    onDiagnostic(message) {
      const url = message.match(/http:\/\/[^ ]+/)?.[0];
      if (url) ready(url);
      overrides.onDiagnostic?.(message);
    },
  });
  void finished.catch(() => {});
  running.push({ controller, finished });
  const url = await urlPromise;
  const page = await fetch(url).then((response) => response.text());
  const secret = page.match(/nonce="([^"]+)"/)![1]!;
  async function post(path: string, value: unknown) {
    const response = await fetch(new URL(path, url), {
      method: "POST",
      headers: {
        Origin: new URL(url).origin,
        "X-IPAB-Web": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, JsonValue>,
    };
  }
  async function session() {
    return (await post("/session", {})).body.session as string;
  }
  return { url, page, secret, post, session, paths, controller, finished };
}

describe("local server", { tags: ["release-e2e"] }, () => {
  it("renders only the frontend index and keeps static assets immutable", async () => {
    const renderFrontend = vi
      .fn()
      .mockResolvedValue("<main>SSR content</main>");
    const app = await start({ renderFrontend });
    const response = await fetch(new URL("frame/index.html", app.url));
    expect(await response.text()).toBe("<main>SSR content</main>");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const script = await fetch(new URL("frame/assets/app.js", app.url));
    expect(await script.text()).toContain("export");
    expect(script.headers.get("cache-control")).toContain("immutable");
    expect(renderFrontend).toHaveBeenCalledTimes(1);
    expect(app.paths).toEqual(["resources/web/assets/app.js"]);
  });
  it("reports oversized SSR responses without serving a partial page", async () => {
    const diagnostic = vi.fn();
    const app = await start({
      renderFrontend: () => Promise.resolve("x".repeat(8 * 1024 * 1024 + 1)),
      onDiagnostic: diagnostic,
    });
    expect((await fetch(new URL("frame/index.html", app.url))).status).toBe(
      500,
    );
    expect(diagnostic).toHaveBeenLastCalledWith(
      expect.stringContaining("exceeds 8 MiB"),
    );
  });
  it.each([
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler"]],
    ["darwin", "open", []],
    ["linux", "xdg-open", []],
  ] as const)(
    "opens the ready URL by default on %s",
    async (platform, command, prefix) => {
      const original =
        await vi.importActual<typeof processes>("node:child_process");
      Object.defineProperty(process, "platform", { value: platform });
      vi.mocked(processes.spawn).mockImplementation(() =>
        original.spawn(process.execPath, ["-e", ""], { stdio: "ignore" }),
      );
      const controller = new AbortController();
      let ready!: (url: string) => void;
      const urlPromise = new Promise<string>((resolve) => {
        ready = resolve;
      });
      const finished = runWebApp({
        context: { appCid: "x", readFile: () => Promise.reject(new Error()) },
        frontendRoot: "web",
        handlers: {},
        signal: controller.signal,
        onDiagnostic(message) {
          ready(message.match(/http:\/\/[^ ]+/)![0]);
        },
      });
      void finished.catch(() => {});
      running.push({ controller, finished });
      const url = await urlPromise;
      expect((await fetch(url)).status).toBe(200);
      expect(processes.spawn).toHaveBeenCalledExactlyOnceWith(
        command,
        [...prefix, url],
        { stdio: "ignore", shell: false },
      );
    },
  );

  it("does not launch a browser when disabled", async () => {
    await start();
    expect(processes.spawn).not.toHaveBeenCalled();
  });

  it("honours --no-open in App arguments even when opening is enabled", async () => {
    process.argv = [process.execPath, "app.cjs", "--no-open"];
    const app = await start({ openBrowser: true });
    expect(processes.spawn).not.toHaveBeenCalled();
    expect((await fetch(app.url)).status).toBe(200);
  });

  it.each(["missing", "exit"] as const)(
    "reports a browser launch %s failure and keeps the URL available",
    async (failure) => {
      const original =
        await vi.importActual<typeof processes>("node:child_process");
      vi.mocked(processes.spawn).mockImplementation(() =>
        failure === "missing"
          ? original.spawn("ipab-missing-browser-command", [], {
              stdio: "ignore",
            })
          : original.spawn(process.execPath, ["-e", "process.exit(7)"], {
              stdio: "ignore",
            }),
      );
      const diagnostic = vi.fn();
      const app = await start({ openBrowser: true, onDiagnostic: diagnostic });
      await vi.waitFor(() => {
        expect(diagnostic).toHaveBeenCalledWith(
          expect.stringContaining("Could not open browser"),
        );
      });
      expect(diagnostic).toHaveBeenLastCalledWith(
        expect.stringContaining(app.url),
      );
      expect((await fetch(app.url)).status).toBe(200);
    },
  );

  it("serves only selected bundle assets and an opaque framework frame", async () => {
    const app = await start();
    expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(app.page).toContain('sandbox="allow-scripts allow-forms"');
    expect(app.page).not.toContain("import(");
    const host = await fetch(app.url);
    expect(host.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(host.headers.get("cache-control")).toBe("no-store");
    const asset = await fetch(new URL("frame/index.html", app.url));
    expect(await asset.text()).toContain("./assets/app.js");
    expect(asset.headers.get("access-control-allow-origin")).toBe("null");
    expect(asset.headers.get("content-security-policy")).toContain(
      "connect-src 'none'",
    );
    expect(asset.headers.get("content-security-policy")).toContain(
      "form-action 'none'",
    );
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const script = await fetch(new URL("frame/assets/app.js", app.url), {
      headers: { Origin: "null" },
    });
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(app.paths).toEqual([
      "resources/web/index.html",
      "resources/web/assets/app.js",
    ]);
    for (const path of [
      "frame/foo.svg",
      "frame/.env",
      "frame/%2e%2e%2fsecret.js",
      "frame/assets%5cfoo.js",
      "frame/missing.js",
      "frame/app.js?x",
      "frame/%ZZ",
    ]) {
      expect(
        (await fetch(new URL(path, app.url))).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(
      (
        await fetch(new URL("frame/assets/app.js", app.url), {
          headers: { Origin: new URL(app.url).origin },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(app.url, { headers: { Origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    expect((await fetch(new URL("unknown", app.url))).status).toBe(403);
    expect((await fetch(app.url, { method: "OPTIONS" })).status).toBe(403);
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        app.url,
        { headers: { Host: "evil.example" } },
        (response) => {
          expect(response.statusCode).toBe(403);
          response.resume();
          response.once("end", resolve);
        },
      );
      request.once("error", reject);
      request.end();
    });
  });

  it("rejects forged, malformed and oversized bridge requests", async () => {
    const app = await start();
    for (const headers of [
      {
        Origin: "https://evil.example",
        "X-IPAB-Web": app.secret,
        "Content-Type": "application/json",
      },
      {
        Origin: "null",
        "X-IPAB-Web": app.secret,
        "Content-Type": "application/json",
      },
      {
        Origin: new URL(app.url).origin,
        "X-IPAB-Web": "wrong",
        "Content-Type": "application/json",
      },
      {
        Origin: new URL(app.url).origin,
        "X-IPAB-Web": app.secret,
        "Content-Type": "text/plain",
      },
    ])
      expect(
        (
          await fetch(new URL("/session", app.url), {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(403);
    expect((await app.post("/call", {})).status).toBe(400);
    expect((await app.post("/call", { session: "absent" })).status).toBe(400);
    expect((await app.post("/call", { x: "a".repeat(70000) })).status).toBe(
      400,
    );
    const session = await app.session();
    expect((await app.post("/unknown", { session })).status).toBe(404);
    expect(
      (
        await app.post("/call", {
          session,
          id: "bad id",
          method: "echo",
          input: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.post("/call", {
          session,
          id: "r1",
          method: "toString",
          input: "",
        })
      ).body.type,
    ).toBe("error");
    expect(
      (await app.post("/call", { session, id: "r2", method: "echo", input: 1 }))
        .body,
    ).toEqual({
      type: "error",
      id: "r2",
      error: { code: "MethodFailed", message: "MethodFailed" },
    });
    await app.post("/cancel", { session, id: "r0" });
  });

  it("separates tab sessions, validates results and delivers queued and waiting events", async () => {
    const app = await start();
    const a = await app.session();
    const b = await app.session();
    expect(a).not.toBe(b);
    expect(
      (
        await app.post("/call", {
          session: a,
          id: "r1",
          method: "echo",
          input: "hello",
        })
      ).body,
    ).toEqual({ type: "result", id: "r1", value: "hello" });
    expect((await app.post("/poll", { session: a })).body.events).toEqual([
      { type: "event", name: "greeting", data: "hello" },
    ]);
    const poll = app.post("/poll", { session: a });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await app.post("/poll", { session: a })).status).toBe(400);
    await app.post("/call", {
      session: a,
      id: "r2",
      method: "echo",
      input: "again",
    });
    expect((await poll).body.events).toEqual([
      { type: "event", name: "greeting", data: "again" },
    ]);
    const untouched = app.post("/poll", { session: b });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.post("/disconnect", { session: b });
    expect((await untouched).body.events).toEqual([]);
    await app.post("/disconnect", { session: a });
    const reconnected = await app.session();
    expect(
      (
        await app.post("/call", {
          session: reconnected,
          id: "r1",
          method: "echo",
          input: "reconnected",
        })
      ).body.type,
    ).toBe("result");
  });

  it("cancels active calls, rejects duplicate IDs and suppresses late events", async () => {
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let late!: () => void;
    const slow = defineWebAppMethod({
      request: { parse: string },
      response: { parse: string },
      handle(_, tools) {
        entered();
        return new Promise<string>((resolve) => {
          late = () => {
            tools.emit("late", null);
            resolve("late");
          };
        });
      },
    });
    const app = await start({ handlers: { slow } });
    const session = await app.session();
    const call = app.post("/call", {
      session,
      id: "r1",
      method: "slow",
      input: "x",
    });
    await enteredPromise;
    expect(
      (
        await app.post("/call", {
          session,
          id: "r1",
          method: "slow",
          input: "x",
        })
      ).body.type,
    ).toBe("error");
    await app.post("/cancel", { session, id: "r1" });
    expect((await call).body.error).toEqual({
      code: "Cancelled",
      message: "Cancelled",
    });
    late();
  });

  it("bounds session counts and event queues", async () => {
    const flood = defineWebAppMethod({
      request: { parse: string },
      response: { parse: string },
      handle(input, { emit }) {
        for (let i = 0; i < 65; ++i) emit("event", input);
        return input;
      },
    });
    const app = await start({ handlers: { flood } });
    const session = await app.session();
    expect(
      (
        await app.post("/call", {
          session,
          id: "r1",
          method: "flood",
          input: "",
        })
      ).body.type,
    ).toBe("error");
    expect(
      ((await app.post("/poll", { session })).body.events as JsonValue[])
        .length,
    ).toBe(64);
    expect(
      (
        await app.post("/call", {
          session,
          id: "r2",
          method: "flood",
          input: "a".repeat(32000),
        })
      ).body.type,
    ).toBe("error");
    for (let i = 1; i < 32; ++i) await app.session();
    expect((await app.post("/session", {})).status).toBe(400);
  });

  it("waits for a first session and closes only after the last reconnect grace", async () => {
    const app = await start();
    let closed = false;
    void app.finished.then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(closed).toBe(false);
    const a = await app.session();
    const b = await app.session();
    await app.post("/disconnect", { session: a });
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(closed).toBe(false);
    await app.post("/disconnect", { session: b });
    await app.finished;
    expect(closed).toBe(true);
  }, 15_000);

  it("rejects signal cancellation after cleanup and rejects bad root paths", async () => {
    const app = await start();
    const session = await app.session();
    const poll = app.post("/poll", { session }).catch(() => undefined);
    app.controller.abort();
    await expect(app.finished).rejects.toMatchObject({ name: "AbortError" });
    await poll;
    expect(await fetch(app.url).catch(() => null)).toBe(null);
    await expect(
      runWebApp({
        context: { appCid: "x", readFile: () => Promise.reject(new Error()) },
        frontendRoot: "../web",
        handlers: {},
      }),
    ).rejects.toThrow("Invalid asset");
    await expect(
      runWebApp({
        context: { appCid: "x", readFile: () => Promise.reject(new Error()) },
        frontendRoot: "web",
        handlers: {
          raw: {
            invoke: () => Promise.resolve(null),
          } as unknown as WebAppMethod,
        },
      }),
    ).rejects.toThrow("both parsers");
    const signal = AbortSignal.abort();
    await expect(
      runWebApp({
        context: { appCid: "x", readFile: () => Promise.reject(new Error()) },
        frontendRoot: "web",
        handlers: {},
        signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      runWebApp({
        context: { appCid: "x", readFile: () => Promise.reject(new Error()) },
        frontendRoot: "web",
        handlers: {},
        onDiagnostic: () => {
          throw new Error("Diagnostic failed");
        },
      }),
    ).rejects.toThrow("Diagnostic failed");
  });

  it("streams backpressured assets and reports reader cleanup failures", async () => {
    const app = await start({
      context: {
        appCid: "app-cid",
        readFile(_cid, path) {
          return Promise.resolve(
            new ReadableStream<Uint8Array>({
              start(stream) {
                if (path.endsWith("large.js")) {
                  stream.enqueue(new Uint8Array(256000));
                  stream.close();
                } else if (path.endsWith("broken.js")) {
                  stream.enqueue(new Uint8Array([1]));
                  setTimeout(() => {
                    stream.error(new Error("Broken stream"));
                  }, 20);
                } else stream.enqueue(new Uint8Array([1]));
              },
              cancel() {
                throw new Error("Reader cleanup failed");
              },
            }),
          );
        },
      },
    });
    const large = await fetch(new URL("frame/large.js", app.url));
    expect((await large.arrayBuffer()).byteLength).toBe(256000);
    const broken = await fetch(new URL("frame/broken.js", app.url));
    await expect(broken.arrayBuffer()).rejects.toThrow();
    const response = await fetch(new URL("frame/pending.js", app.url));
    const read = response.arrayBuffer().catch(() => undefined);
    app.controller.abort();
    await expect(app.finished).rejects.toThrow("Web App cleanup failed");
    await read;
  });

  it("expires vanished sessions, times out calls and returns empty heartbeat polls", async () => {
    const slow = defineWebAppMethod({
      request: { parse: string },
      response: { parse: string },
      handle: () => new Promise<string>(() => {}),
    });
    const app = await start({ handlers: { slow } });
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (handler, delay, ...args: unknown[]) =>
        original(
          handler,
          delay === 10000
            ? 20
            : delay === 30000
              ? 80
              : delay === 3000
                ? 20
                : delay,
          ...args,
        ),
    );
    const session = await app.session();
    expect((await app.post("/poll", { session })).body.events).toEqual([]);
    const call = await app.post("/call", {
      session,
      id: "r1",
      method: "slow",
      input: "",
    });
    expect(call.body.error).toEqual({
      code: "Cancelled",
      message: "Cancelled",
    });
    await app.finished;
    vi.restoreAllMocks();
  });

  it("bounds simultaneous calls and aborts them when a tab disconnects", async () => {
    const slow = defineWebAppMethod({
      request: { parse: string },
      response: { parse: string },
      handle: () => new Promise<string>(() => {}),
    });
    const app = await start({ handlers: { slow } });
    const session = await app.session();
    const calls = Array.from({ length: 32 }, (_, index) =>
      app.post("/call", {
        session,
        id: `r${index}`,
        method: "slow",
        input: "",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (
        await app.post("/call", {
          session,
          id: "overflow",
          method: "slow",
          input: "",
        })
      ).body.type,
    ).toBe("error");
    await app.post("/disconnect", { session });
    expect(
      (await Promise.all(calls)).every((call) => call.body.type === "error"),
    ).toBe(true);
  });
});
