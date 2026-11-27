import { test, expect } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CarBlockIterator } from "@ipld/car/iterator";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { randomBytes, toBase64Url, sha256Hex } from "../src/crypto.ts";
import { runCli } from "@ipab/cli";
import { createService } from "./helpers.ts";

interface Result {
  code: number;
  out: string;
  err: string;
}
// Workers types shadow Node's process/Buffer globals; keep this Node fixture narrowly typed.
const runtime = globalThis as unknown as {
  process: { env: NodeJS.ProcessEnv; execPath: string; platform: string };
};
function concatenate(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
test(
  "two accounts iterate a Name through the canonical Worker router",
  { tags: ["release-e2e"], timeout: 240_000 },
  async () => {
    const base = resolve(".test-work");
    await mkdir(base, { recursive: true });
    const work = await mkdtemp(join(base, "mvp-"));
    const apiKey = toBase64Url(randomBytes(32));
    const blocks = new Map<string, Uint8Array>();
    const pins = new Set<string>();
    let failProvider = false;
    let casConflicts = 0;
    let barrierReads = 0;
    let releaseReads: (() => void)[] = [];
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        const body: Uint8Array[] = [];
        for await (const chunk of incoming)
          body.push(Uint8Array.from(chunk as Uint8Array));
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${incoming.url!}`;
        const request = new Request(url, {
          method: incoming.method!,
          headers: incoming.headers as Record<string, string>,
          ...(body.length ? { body: concatenate(body) } : {}),
        });
        let response: Response;
        if (incoming.url?.startsWith("/api/v0/dag/import")) {
          if (failProvider)
            response = new Response("unavailable", { status: 503 });
          else {
            const form = await request.formData();
            const file = form.get("file");
            if (!(file instanceof Blob))
              throw new Error("Expected Kubo CAR form");
            const iterator = await CarBlockIterator.fromBytes(
              new Uint8Array(await file.arrayBuffer()),
            );
            const roots = await iterator.getRoots();
            for await (const block of iterator) {
              expect(block.cid.multihash.digest).toEqual(
                (await sha256.digest(block.bytes)).digest,
              );
              blocks.set(block.cid.toV1().toString(), block.bytes);
            }
            for (const root of roots) {
              expect(blocks.has(root.toV1().toString())).toBe(true);
              pins.add(root.toV1().toString());
            }
            response = new Response(
              roots
                .map((cid) =>
                  JSON.stringify({
                    Root: { Cid: { "/": cid.toString() }, PinErrorMsg: "" },
                  }),
                )
                .join("\n"),
            );
          }
        } else if (incoming.url?.startsWith("/ipfs/")) {
          const cid = CID.parse(new URL(url).pathname.split("/")[2]!)
            .toV1()
            .toString();
          response = blocks.has(cid)
            ? new Response(Uint8Array.from(blocks.get(cid)!), {
                headers: { "content-type": "application/vnd.ipld.raw" },
              })
            : new Response("not found", { status: 404 });
        } else {
          response = await service.fetch(request);
          if (response.status === 412) casConflicts++;
          if (
            incoming.method === "GET" &&
            /^\/v1\/pointers\/[A-Za-z0-9_-]+$/.test(new URL(url).pathname) &&
            barrierReads > 0
          ) {
            barrierReads--;
            await new Promise<void>((accept) => {
              releaseReads.push(accept);
              if (barrierReads === 0) {
                for (const release of releaseReads) release();
                releaseReads = [];
              }
            });
          }
        }
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        outgoing.end(new Uint8Array(await response.arrayBuffer()));
      })().catch((error: unknown) => {
        outgoing.writeHead(500);
        outgoing.end(error instanceof Error ? error.message : "fixture failed");
      });
    });
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const service = await createService({
      service: endpoint,
      digest: await sha256Hex(apiKey),
    });
    const cli = fileURLToPath(
      new URL("../../../apps/cli/dist/main.js", import.meta.url),
    );
    const homeA = join(work, "a"),
      homeB = join(work, "b"),
      homeC = join(work, "c");
    const environments = new Map<string, NodeJS.ProcessEnv>();
    const inherited = { ...runtime.process.env };
    delete inherited.IPAB_POINTERS_SERVICE;
    delete inherited.IPAB_POINTERS_API_KEY;
    for (const home of [homeA, homeB, homeC]) {
      await mkdir(home);
      const config = join(home, "content.json");
      await writeFile(
        config,
        JSON.stringify({
          backend: "local",
          dataDir: join(home, "blocks"),
          gateway: endpoint,
        }),
      );
      environments.set(home, {
        ...inherited,
        HOME: home,
        USERPROFILE: home,
        TASK_CONTENT_CONFIG: config,
        IPAB_STATE_DIR: join(home, "state"),
        IPAB_SWARM_PROVIDER: endpoint,
        IPAB_STORE_GATEWAY: endpoint,
        IPAB_HISTORY_ENABLED: "false",
      });
    }
    const invoke = async (
      home: string,
      args: string[],
      cwd = work,
    ): Promise<Result> =>
      new Promise((accept, reject) => {
        const child = spawn(runtime.process.execPath, [cli, ...args], {
          cwd,
          env: environments.get(home),
          shell: false,
        });
        let out = "",
          err = "";
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, 30_000);
        child.stdout.setEncoding("utf8").on("data", (value: string) => {
          out += value;
        });
        child.stderr.setEncoding("utf8").on("data", (value: string) => {
          err += value;
        });
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timeout);
          if (timedOut)
            reject(
              new Error(`CLI timeout at ${args.join(" ")}; stderr: ${err}`),
            );
          else accept({ code: code ?? 1, out, err });
        });
      });
    const cidResult = async (home: string, args: string[], cwd?: string) => {
      const result = await invoke(home, args, cwd);
      expect(result, result.err).toMatchObject({ code: 0 });
      expect(result.out.trim().split(/\r?\n/)).toHaveLength(1);
      return CID.parse(result.out.trim()).toV1().toString();
    };
    try {
      const cfgMessages: string[] = [];
      const envA = environments.get(homeA);
      if (!envA) throw new Error("Missing isolated owner environment.");
      const cfgIO = {
        out: (value: string) => {
          cfgMessages.push(value);
        },
        err: (value: string) => {
          cfgMessages.push(value);
        },
        tty: false,
        confirm: () => Promise.resolve(false),
        readSecret: () => Promise.resolve(apiKey),
      };
      expect(
        await runCli(
          ["config", "set", "pointers.service", endpoint],
          cfgIO,
          envA,
        ),
      ).toBe(0);
      expect(
        await runCli(["config", "set", "pointers.apiKey", "-"], cfgIO, envA),
      ).toBe(0);
      expect(cfgMessages.some((value) => value.includes(apiKey))).toBe(false);
      const swarm = await cidResult(homeA, [
        "swarm",
        "create",
        "--service",
        endpoint,
      ]);
      environments.get(homeA)!.IPAB_SWARM = swarm;
      environments.get(homeB)!.IPAB_SWARM = swarm;
      const keyA = await readFile(
        join(homeA, ".ipab", "identity", "key.json"),
        "utf8",
      );
      const request = await cidResult(homeB, ["swarm", "request", swarm]);
      expect((await invoke(homeB, ["swarm", "status"])).code).not.toBe(0);
      const response = await cidResult(homeA, [
        "swarm",
        "approve",
        request,
        "--yes",
      ]);
      expect((await invoke(homeC, ["swarm", "join", response])).code).not.toBe(
        0,
      );
      expect(await cidResult(homeB, ["swarm", "join", response])).toBe(swarm);
      expect((await invoke(homeB, ["swarm", "status"])).code).toBe(0);
      const source = join(work, "source-v1");
      await mkdir(source);
      await writeFile(
        join(source, ".bundle.yaml"),
        "name: Source\nentry:\n  path: main.cjs\n  contentType: text/plain\n",
      );
      await writeFile(
        join(source, "main.cjs"),
        'console.log("Hello " + process.argv[2]);\n',
      );
      const srcBuild = await invoke(homeA, [
        "--json",
        "bundle",
        "build",
        source,
      ]);
      expect(srcBuild, srcBuild.err).toMatchObject({ code: 0 });
      const sourceCid = (JSON.parse(srcBuild.out) as { cid: string }).cid;
      const project = join(work, "app");
      await mkdir(project);
      const { appSchema } = await import("@ipab/cli/devtools");
      await writeFile(join(project, ".bundle.yaml"), JSON.stringify(appSchema));
      await writeFile(
        join(project, "app.json"),
        JSON.stringify({
          name: "hello",
          version: "1.0.0",
          description: "",
          entry: "resources/app.cjs",
          source: { cid: sourceCid },
        }),
      );
      await writeFile(
        join(project, "main.cjs"),
        await readFile(join(source, "main.cjs")),
      );
      await writeFile(
        join(project, "ipab.build.yaml"),
        "version: 1\nfiles:\n  - source: app.json\n    target: app.json\n  - source: main.cjs\n    target: resources/app.cjs\nimports: []\n",
      );
      const built = await invoke(homeA, ["--json", "build", project]);
      expect(built, built.err).toMatchObject({ code: 0 });
      const appV1 = (JSON.parse(built.out) as { cid: string }).cid;
      const releaseV1 = await cidResult(homeA, [
        "publish",
        appV1,
        "--name",
        "apps/hello",
      ]);
      expect(
        (await invoke(homeB, ["exec", "name:apps/hello", "Alice"])).out,
      ).toBe("Hello Alice\n");
      const downloaded = await invoke(homeB, [
        "--json",
        "get",
        "name:apps/hello",
        "-o",
        join(work, "downloaded-app"),
      ]);
      expect(downloaded, downloaded.err).toMatchObject({ code: 0 });
      expect(JSON.parse(downloaded.out)).toMatchObject({
        targetCid: releaseV1,
        cid: appV1,
      });
      const sourceDir = join(work, "downloaded-source");
      expect(
        (await invoke(homeB, ["get", sourceCid, "-o", sourceDir])).code,
      ).toBe(0);
      await writeFile(
        join(sourceDir, "main.cjs"),
        'console.log("Welcome " + process.argv[2]);\n',
      );
      const sourceV2Build = await invoke(homeB, [
        "--json",
        "bundle",
        "build",
        sourceDir,
      ]);
      expect(sourceV2Build, sourceV2Build.err).toMatchObject({ code: 0 });
      const sourceV2 = (JSON.parse(sourceV2Build.out) as { cid: string }).cid;
      await writeFile(
        join(project, "main.cjs"),
        await readFile(join(sourceDir, "main.cjs")),
      );
      await writeFile(
        join(project, "app.json"),
        JSON.stringify({
          name: "hello",
          version: "2.0.0",
          description: "",
          entry: "resources/app.cjs",
          source: { cid: sourceV2 },
        }),
      );
      const builtV2 = await invoke(homeB, [
        "--json",
        "build",
        project,
        "--replace",
      ]);
      expect(builtV2, builtV2.err).toMatchObject({ code: 0 });
      const appV2 = (JSON.parse(builtV2.out) as { cid: string }).cid;
      const releaseV2 = await cidResult(homeB, [
        "publish",
        appV2,
        "--name",
        "apps/hello",
        "--expect",
        releaseV1,
      ]);
      expect(releaseV2).not.toBe(releaseV1);
      expect(
        (await invoke(homeA, ["exec", "name:apps/hello", "Alice"])).out,
      ).toBe("Welcome Alice\n");
      expect((await invoke(homeB, ["exec", releaseV1, "Alice"])).out).toBe(
        "Hello Alice\n",
      );
      const rawDir = join(work, "raw-release");
      expect(
        (await invoke(homeA, ["get", "--raw", "name:apps/hello", "-o", rawDir]))
          .code,
      ).toBe(0);
      expect(
        JSON.parse(await readFile(join(rawDir, "entry.json"), "utf8")),
      ).toMatchObject({ value: appV2, previous: releaseV1 });
      expect(await runCli(["exec", "--raw", releaseV2], cfgIO, envA)).toBe(2);
      expect(
        (
          await invoke(homeA, [
            "publish",
            appV1,
            "--name",
            "apps/hello",
            "--expect",
            releaseV1,
          ])
        ).code,
      ).toBe(3);
      barrierReads = 2;
      const concurrent = await Promise.all([
        invoke(homeA, [
          "publish",
          appV1,
          "--name",
          "apps/hello",
          "--expect",
          releaseV2,
        ]),
        invoke(homeB, [
          "publish",
          appV2,
          "--name",
          "apps/hello",
          "--expect",
          releaseV2,
        ]),
      ]);
      expect(concurrent.map((result) => result.code).sort()).toEqual([0, 3]);
      const conflictsBeforeDifferentNames = casConflicts;
      barrierReads = 2;
      const different = await Promise.all([
        invoke(homeA, ["publish", appV1, "--name", "apps/one"]),
        invoke(homeB, ["publish", appV2, "--name", "apps/two"]),
      ]);
      expect(different.map((result) => result.code)).toEqual([0, 0]);
      expect(casConflicts).toBeGreaterThan(conflictsBeforeDifferentNames);
      expect(
        (await invoke(homeA, ["exec", "name:apps/one", "Alice"])).out,
      ).toBe("Hello Alice\n");
      expect(
        (await invoke(homeB, ["exec", "name:apps/two", "Alice"])).out,
      ).toBe("Welcome Alice\n");
      failProvider = true;
      expect(
        (await invoke(homeA, ["publish", appV1, "--name", "apps/not-shared"]))
          .code,
      ).not.toBe(0);
      failProvider = false;
      expect(
        (await invoke(homeA, ["get", "name:apps/not-shared"])).code,
      ).not.toBe(0);
      expect(
        await readFile(join(homeA, ".ipab", "identity", "key.json"), "utf8"),
      ).toBe(keyA);
      expect(
        pins.has(sourceCid) &&
          pins.has(sourceV2) &&
          pins.has(appV1) &&
          pins.has(appV2),
      ).toBe(true);
    } finally {
      await new Promise<void>((accept, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else accept();
        }),
      );
      await rm(work, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
