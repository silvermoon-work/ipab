import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { encodeSchema, parseBundleManifest } from "@ipab/bundle";
import { describe, expect, it, vi } from "vitest";
import { viewer } from "../src/shared/viewer.js";
import definition from "../schemas/check.json" with { type: "json" };
import { checkSpecDefinition } from "@ipab/check-spec/bundle";

describe("shared Check component", { tags: ["unit"] }, () => {
  it("renders the shared Check component using real definition data", () => {
    expect(definition).toEqual(checkSpecDefinition);
    const html = renderToString(
      createElement(viewer, {
        data: {
          specVersion: "1.0",
          name: "Untitled Check",
          description: "Describe the scope of the check.",
          parameter: { schema: { type: "object" } },
          checkpoints: [
            {
              id: "review",
              title: "Review",
              description: "Review the supplied target.",
              instructions: "Read the target and report evidence.",
              output: { description: "Successful output is undefined." },
              rules: [
                {
                  code: "target-valid",
                  description: "The target meets the documented requirements.",
                },
              ],
            },
          ],
        },
      }),
    );
    expect(html).toContain("Untitled Check");
    expect(html).toContain("Review");
    expect(html).toContain("任务总览");
  });
});

describe("built Check viewer App", { tags: ["release-e2e"] }, () => {
  it.each(["cid", "folder", "pin"])(
    "executes the actual App CAR and resolves Markdown from %s before SSR",
    async (mode) => {
      const work = await mkdtemp(join(tmpdir(), "ipab-check-viewer-"));
      const cli = fileURLToPath(
        new URL("../../cli/dist/main.js", import.meta.url),
      );
      const app = fileURLToPath(new URL("../dist/app.car", import.meta.url));
      const example = fileURLToPath(
        new URL("../../../examples/check-spec", import.meta.url),
      );
      const env = {
        ...process.env,
        TASK_CONTENT_CONFIG: join(work, "store.json"),
      };
      await writeFile(
        env.TASK_CONTENT_CONFIG,
        JSON.stringify({ backend: "local", dataDir: join(work, "blocks") }),
      );
      const args = ["--state-dir", join(work, "state"), "--json"];
      async function command(values: string[]): Promise<{ cid: string }> {
        const result = await promisify(execFile)(
          process.execPath,
          [cli, ...args, ...values],
          { env },
        );
        const value: unknown = JSON.parse(result.stdout);
        if (
          !value ||
          typeof value !== "object" ||
          !("cid" in value) ||
          typeof value.cid !== "string"
        )
          throw new Error("CLI did not return a content CID");
        return { cid: value.cid };
      }
      let child: ReturnType<typeof spawn> | undefined;
      let closed: Promise<number | null> | undefined;
      try {
        const schema = parseBundleManifest(
          await readFile(join(example, ".bundle.yaml")),
        );
        expect((await encodeSchema(schema)).cid.toString()).toBe(
          (await encodeSchema(definition)).cid.toString(),
        );
        const appIdentity = await command(["bundle", "import", app]);
        const local = join(work, "folder");
        let source = local;
        if (mode === "folder") {
          await mkdir(join(local, "instructions"), { recursive: true });
          for (const path of [
            ".bundle.yaml",
            "check.yaml",
            "instructions/project.md",
            "instructions/workspace.md",
          ])
            await writeFile(
              join(local, ...path.split("/")),
              await readFile(join(example, ...path.split("/"))),
            );
        } else {
          const content = await command([
            "bundle",
            "build",
            example,
            "-o",
            join(work, "content.car"),
          ]);
          source = content.cid;
          if (mode === "pin") {
            source = "my-check";
            await promisify(execFile)(
              process.execPath,
              [cli, ...args, "pin", "add", source, content.cid],
              { env },
            );
          }
        }
        child = spawn(
          process.execPath,
          [
            cli,
            "--state-dir",
            join(work, "state"),
            "exec",
            appIdentity.cid,
            source,
            "--no-open",
          ],
          {
            env,
            stdio: ["ignore", "ignore", "pipe"],
            shell: false,
          },
        );
        let log = "";
        let readyResolve!: (url: string) => void;
        let readyReject!: (error: Error) => void;
        const ready = new Promise<string>((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
        child.stderr!.on("data", (chunk: Buffer) => {
          log += chunk.toString();
          const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(log)?.[0];
          if (url) readyResolve(url);
        });
        closed = new Promise((resolve, reject) => {
          child!.once("error", (error) => {
            readyReject(error);
            reject(error);
          });
          child!.once("close", (code) => {
            readyReject(new Error(`Check App exited: ${log}`));
            resolve(code);
          });
        });
        const url = await ready;
        const host = await fetch(url).then((response) => response.text());
        const secret = /nonce="([^"]+)"/.exec(host)![1]!;
        const post = (path: string, data: unknown) =>
          fetch(new URL(path, url), {
            method: "POST",
            headers: {
              Origin: new URL(url).origin,
              "X-IPAB-Web": secret,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
          });
        const session: unknown = await post("/session", {}).then((response) =>
          response.json(),
        );
        const response = await fetch(new URL("frame/index.html", url));
        const html = await response.text();
        expect(response.status, log).toBe(200);
        expect(html).toContain("TypeScript 项目");
        expect(html).toContain("任务总览");
        expect(html).toContain("Workspace 配置");
        expect(html).not.toContain("<!--ipab:viewer-->");
        const state = /type="application\/json">([^<]+)<\/script>/.exec(
          html,
        )![1]!;
        expect(state).toContain("只读核对根 manifest");
        expect(state).toContain("报告准确字段");
        expect(state).not.toContain('"instructions":{"path"');
        expect(response.headers.get("cache-control")).toBe("no-store");
        if (mode === "folder") {
          await writeFile(
            join(local, "instructions", "project.md"),
            "Local Markdown auto update",
          );
          await vi.waitFor(
            async () => {
              const changed = await fetch(
                new URL("frame/index.html", url),
              ).then((value) => value.text());
              expect(changed).toContain("Local Markdown auto update");
              expect(changed).toContain('id="ipab-viewer-live"');
            },
            { timeout: 5000, interval: 300 },
          );
        }
        await post("/disconnect", session);
        expect(await closed, log).toBe(0);
      } finally {
        if (
          child?.pid &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          if (process.platform === "win32")
            await promisify(execFile)("taskkill.exe", [
              "/PID",
              String(child.pid),
              "/T",
              "/F",
            ]);
          else child.kill("SIGTERM");
        }
        if (closed) await closed;
        await rm(work, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
