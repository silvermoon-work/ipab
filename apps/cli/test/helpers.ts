import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { IpfsStore } from "@ipab/ipfs-store";
import { encodeSchema, canonicalJson, type JsonSchema } from "@ipab/bundle";
import { importer } from "ipfs-unixfs-importer";
import type { CID } from "multiformats/cid";
import { appSchema } from "../src/space.js";
import type { RunRecord } from "../src/state.js";
import { runCli, type IO } from "../src/cli.js";

export async function fixture(): Promise<{
  root: string;
  stateDir: string;
  store: IpfsStore;
  cleanup: () => Promise<void>;
}> {
  const root = resolve(".test-work", randomUUID());
  await mkdir(root, { recursive: true });
  const store = new IpfsStore({
    backend: "local",
    dataDir: join(root, "blocks"),
  });
  return {
    root,
    store,
    stateDir: join(root, "state"),
    async cleanup() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function importFiles(
  store: IpfsStore,
  files: Record<string, string | Uint8Array>,
): Promise<string> {
  const session = `fixture:${randomUUID()}`;
  let root: CID | undefined;
  for await (const item of importer(
    Object.entries(files).map(([path, content]) => ({
      path,
      content:
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content,
    })),
    {
      async put(cid, block) {
        if (!(block instanceof Uint8Array))
          throw new Error("Unexpected fixture block input.");
        await store.stageBlock(session, cid, block);
        return cid;
      },
    },
    { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true },
  ))
    root = item.cid;
  if (!root) throw new Error("No fixture root.");
  await store.finishImport(session, root, "fixtures");
  await store.confirmRetained("fixtures", [root.toString()]);
  return root.toString();
}

export async function content(
  store: IpfsStore,
  value: unknown = { hello: "world" },
  schema: JsonSchema = { type: "object" },
): Promise<{ root: string; schema: string }> {
  const definition = {
    name: "Fixture",
    description: "",
    entry: {
      path: "data.json",
      schema,
      contentType: "application/json",
      defaultValue: value,
    },
  };
  const encoded = await encodeSchema(definition);
  const schemaCid = encoded.cid.toString();
  const root = await importFiles(store, {
    ".bundle.yaml": canonicalJson(definition),
    "data.json": JSON.stringify(value),
  });
  return { root, schema: schemaCid };
}

export async function app(store: IpfsStore, source: string): Promise<string> {
  return importFiles(store, {
    ".bundle.yaml": canonicalJson(appSchema),
    "app.json": JSON.stringify({
      name: "Fixture App",
      version: "0.0.0",
      description: "",
      entry: "resources/app.cjs",
    }),
    "resources/app.cjs": source,
  });
}

export function record(
  id: string,
  cid: string,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return {
    id,
    appCid: cid,
    origin: "exec",
    argv: [],
    startedAt: "2026-11-23T00:00:00Z",
    endedAt: "2026-11-23T00:00:01Z",
    status: "succeeded",
    outputCid: null,
    appExitCode: 0,
    error: null,
    retention: { owned: false, state: "none" },
    ...overrides,
  };
}

export async function cli(
  directory: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    tty?: boolean;
    columns?: number;
    confirm?: IO["confirm"];
    diagnostic?: (text: string) => void;
  } = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [],
    err: string[] = [];
  const code = await runCli(
    ["--state-dir", directory, ...args],
    {
      out(text) {
        out.push(text);
      },
      err(text) {
        err.push(text);
        options.diagnostic?.(text);
      },
      tty: options.tty ?? false,
      columns() {
        return options.columns;
      },
      confirm: options.confirm ?? (() => Promise.resolve(false)),
    },
    options.env ?? {},
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

export async function subprocess(
  args: string[],
  config: string,
  input: Uint8Array = new Uint8Array(),
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TASK_CONTENT_CONFIG: config,
  };
  for (const key of [
    "IPAB_STATE_DIR",
    "IPAB_STORE_RPC",
    "IPAB_HISTORY_ENABLED",
    "IPAB_HISTORY_LIMIT",
    "IPAB_OUTPUT_RETENTION",
  ])
    delete env[key];
  const child = spawn(process.execPath, [resolve("dist", "main.js"), ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on("data", (bytes: Buffer) => {
    stdout.push(bytes);
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr.push(bytes);
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code);
    });
  });
  return {
    code,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString(),
  };
}
