import { describe, expect, it } from "vitest";
import { options, secretDigest, targetConfig } from "../src/main.js";
import { bytes } from "../src/setup.js";
import { readWorker } from "../src/worker.js";
import definition from "../../../packages/pointer-worker/bundle-definition.json" with { type: "json" };

const stream = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(value));
      controller.close();
    },
  });

describe("Worker consumers", { tags: ["unit"] }, () => {
  it("defaults to dry-run, separates local flags and consumes reinstall", () => {
    expect(
      options("deploy", ["worker", "--target", "target.json", "--reinstall"]),
    ).toMatchObject({ deploy: false, reinstall: true });
    expect(
      options("deploy", ["worker", "--target", "target.json", "--deploy"])
        .deploy,
    ).toBe(true);
    expect(options("local", ["worker", "--port", "9999"]).port).toBe(9999);
    for (const args of [
      ["worker", "--deploy"],
      ["worker", "--port", "0"],
      ["worker", "--target", "x"],
      ["worker", "--secrets-file"],
    ])
      expect(() => options("local", args)).toThrow();
    expect(() => options("deploy", ["worker"])).toThrow("--target");
    expect(() => options("local", [])).toThrow("required");
    expect(options("local", ["--help"]).help).toBe(true);
    expect(options("deploy", ["--help"]).help).toBe(true);
    for (const args of [
      ["worker", "--port", "abc"],
      ["worker", "--port", "65536"],
      ["worker", "--port", "--reinstall"],
      ["worker", "other"],
      ["worker", "--unknown"],
    ])
      expect(() => options("local", args)).toThrow();
    expect(() => options("deploy", ["worker", "--port", "8787"])).toThrow(
      "supported",
    );
    expect(() => options("deploy", ["worker", "--state-dir", "state"])).toThrow(
      "supported",
    );
  });

  it("does not allow targets to replace the code or portable runtime contract", () => {
    const target = {
      name: "test-pointer",
      account_id: "a".repeat(32),
      vars: { POINTER_SERVICE: "https://pointers.example.com" },
    };
    expect(targetConfig(target)).toEqual(target);
    for (const patch of [
      { main: "evil.js" },
      { migrations: [] },
      { account_id: "" },
      { vars: { POINTER_SERVICE: "http://pointers.example.com" } },
      { vars: { POINTER_SERVICE: "https://pointers.example.com/path" } },
      {
        vars: {
          POINTER_SERVICE: "https://pointers.example.com",
          POINTER_API_KEY_SHA256: "secret",
        },
      },
    ])
      expect(() => targetConfig({ ...target, ...patch })).toThrow();
    expect(secretDigest({ POINTER_API_KEY_SHA256: "a".repeat(64) })).toBe(
      "a".repeat(64),
    );
    expect(() => secretDigest({ POINTER_API_KEY_SHA256: "raw-key" })).toThrow();
  });

  it("validates deployment instance shapes including routes and secret inputs", () => {
    const target = {
      name: "test-pointer",
      account_id: "a".repeat(32),
      vars: {
        POINTER_SERVICE: "https://pointers.example.com",
        ALLOWED_ORIGIN: "",
      },
    };
    expect(
      targetConfig({
        ...target,
        workers_dev: false,
        routes: [
          "pointers.example.com/*",
          { pattern: "pointers.example.com", custom_domain: true },
        ],
      }),
    ).toMatchObject({ workers_dev: false });
    for (const value of [
      null,
      { ...target, name: 7 },
      { ...target, name: "INVALID" },
      { ...target, account_id: 1 },
      { ...target, workers_dev: "true" },
      { ...target, routes: "route" },
      { ...target, routes: [null] },
      { ...target, routes: [{}] },
      { ...target, routes: [{ pattern: "x", unexpected: true }] },
      { ...target, vars: null },
      { ...target, vars: {} },
      { ...target, vars: { ...target.vars, ALLOWED_ORIGIN: 1 } },
    ])
      expect(() => targetConfig(value)).toThrow();
    for (const value of [
      null,
      {},
      { POINTER_API_KEY_SHA256: 1 },
      { POINTER_API_KEY_SHA256: "a".repeat(64), extra: "" },
    ])
      expect(() => secretDigest(value)).toThrow();
  });

  it("validates type identity, descriptor and portable file paths before installation", async () => {
    let manifest: unknown = definition;
    let paths = ["worker.mjs"];
    const files = {
      appCid: "",
      readFile: (_cid: string, path: string) =>
        Promise.resolve(
          stream(
            JSON.stringify(
              path === ".bundle.yaml"
                ? manifest
                : {
                    version: 1,
                    files: paths,
                    config: {
                      main: "worker.mjs",
                      compatibility_date: "2026-01-01",
                    },
                  },
            ),
          ),
        ),
    };
    await expect(readWorker(files, "input")).resolves.toMatchObject({
      paths: ["worker.mjs"],
    });
    for (const invalid of [
      ["../worker.mjs"],
      ["worker.mjs", "WORKER.MJS"],
      ["worker.mjs", ".dev.vars"],
      ["other.mjs"],
    ]) {
      paths = invalid;
      await expect(readWorker(files, "input")).rejects.toThrow();
    }
    manifest = { ...definition, name: "Other type" };
    await expect(readWorker(files, "input")).rejects.toThrow("type");
  });

  it("cancels oversized input streams", async () => {
    await expect(bytes(stream("oversized"), 2)).rejects.toThrow("budget");
  });
});
