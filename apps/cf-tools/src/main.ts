import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CID } from "multiformats/cid";
import { parseData } from "@ipab/bundle/data";
import {
  readProtected,
  saveProtected,
} from "../../../packages/pointer-worker/src/protected-files.ts";
import type { AppContext } from "../../cli/dist/context.js";
import { bytes, runNode, withInstallation } from "./setup.js";
import { object, readWorker } from "./worker.js";

declare global {
  var ipab: AppContext;
}

export function options(mode: "local" | "deploy", args: string[]) {
  const result = {
    source: "",
    reinstall: false,
    deploy: false,
    port: 8787,
    state: "",
    target: "",
    secrets: "",
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help") result.help = true;
    else if (arg === "--reinstall") result.reinstall = true;
    else if (arg === "--deploy" && mode === "deploy") result.deploy = true;
    else if (
      ["--port", "--state-dir", "--target", "--secrets-file"].includes(arg)
    ) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value.`);
      if (arg === "--port" && mode === "local") {
        if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535)
          throw new Error("Port must be an integer in 1..65535.");
        result.port = Number(value);
      } else if (arg === "--state-dir" && mode === "local")
        result.state = resolve(value);
      else if (arg === "--target" && mode === "deploy")
        result.target = resolve(value);
      else if (arg === "--secrets-file") result.secrets = resolve(value);
      else throw new Error(`${arg} is not supported by cf-${mode}.`);
    } else if (!arg.startsWith("-") && !result.source) result.source = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.help && !result.source)
    throw new Error("A Worker Bundle CID or pin is required.");
  if (!result.help && mode === "deploy" && !result.target)
    throw new Error(
      "cf-deploy requires --target with an explicit deployment target.",
    );
  return result;
}

export function targetConfig(value: unknown): Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !["name", "account_id", "routes", "workers_dev", "vars"].includes(key),
    )
  )
    throw new Error(
      "Target accepts only name, account_id, routes, workers_dev and vars.",
    );
  if (
    typeof value.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.name) ||
    typeof value.account_id !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.account_id)
  )
    throw new Error(
      "Target requires an explicit Worker name and 32-character account_id.",
    );
  if (value.workers_dev !== undefined && typeof value.workers_dev !== "boolean")
    throw new Error("workers_dev must be boolean.");
  if (
    value.routes !== undefined &&
    (!Array.isArray(value.routes) ||
      value.routes.some(
        (route: unknown) =>
          typeof route !== "string" &&
          (!object(route) ||
            typeof route.pattern !== "string" ||
            Object.keys(route).some(
              (key) =>
                !["pattern", "zone_name", "zone_id", "custom_domain"].includes(
                  key,
                ),
            )),
      ))
  )
    throw new Error("Invalid target routes.");
  if (!object(value.vars) || typeof value.vars.POINTER_SERVICE !== "string")
    throw new Error("Target vars requires POINTER_SERVICE.");
  const origin = new URL(value.vars.POINTER_SERVICE);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value.vars.POINTER_SERVICE
  )
    throw new Error("POINTER_SERVICE must be a canonical HTTPS origin.");
  if (
    Object.entries(value.vars).some(
      ([key, item]) =>
        !["POINTER_SERVICE", "ALLOWED_ORIGIN"].includes(key) ||
        typeof item !== "string",
    )
  )
    throw new Error(
      "Only non-secret POINTER_SERVICE and ALLOWED_ORIGIN vars are allowed.",
    );
  return value;
}

export function secretDigest(value: unknown): string {
  if (
    !object(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.POINTER_API_KEY_SHA256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.POINTER_API_KEY_SHA256)
  )
    throw new Error(
      "Secrets JSON must contain only POINTER_API_KEY_SHA256 (64 lowercase hex characters).",
    );
  return value.POINTER_API_KEY_SHA256;
}

export async function main(mode: "local" | "deploy"): Promise<void> {
  const args = options(mode, process.argv.slice(2));
  if (args.help) {
    console.log(
      `cf-${mode} <worker-cid-or-pin> [--reinstall] [--secrets-file JSON]\n` +
        (mode === "local"
          ? "  [--port 8787] [--state-dir PATH]\n"
          : "  --target JSON [--deploy]\nDefault: deployment dry-run; --deploy explicitly enables remote writes.\n"),
    );
    return;
  }
  const context = globalThis.ipab;
  let cid: string;
  try {
    cid = CID.parse(args.source).toV1().toString();
  } catch {
    const pin = await context.resolvePin(args.source);
    if (!pin) throw new Error(`Unknown Worker Bundle pin: ${args.source}`);
    cid = CID.parse(pin).toV1().toString();
  }
  const worker = await readWorker(context, cid);
  const target =
    mode === "deploy"
      ? targetConfig(parseData(await readFile(args.target), "application/json"))
      : {
          name: "ipab-pointer-local",
          vars: {
            POINTER_SERVICE: `http://127.0.0.1:${args.port}`,
            ALLOWED_ORIGIN: "",
          },
        };
  const digest = args.secrets
    ? secretDigest(
        parseData(
          Buffer.from(await readProtected(args.secrets)),
          "application/json",
        ),
      )
    : undefined;
  await withInstallation(context, args.reinstall, async (installation) => {
    const temp = await mkdtemp(join(tmpdir(), "ipab-cf-run-"));
    const run = join(temp, "private");
    try {
      await saveProtected(
        join(run, "wrangler.json"),
        JSON.stringify({ ...worker.config, ...target, no_bundle: true }),
      );
      let total = 0;
      for (const path of worker.paths) {
        const content = await bytes(await context.readFile(cid, path));
        total += content.length;
        if (total > 32 * 1024 * 1024)
          throw new Error("Worker exceeds total file byte budget.");
        const destination = join(run, ...path.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
      }
      const entry = join(
        installation,
        "node_modules",
        "wrangler",
        "bin",
        "wrangler.js",
      );
      const command =
        mode === "local"
          ? [
              "dev",
              "--local",
              "--ip",
              "127.0.0.1",
              "--port",
              String(args.port),
              "--persist-to",
              args.state ||
                join(homedir(), ".ipab", "cf-state", String(target.name)),
              "--show-interactive-dev-session=false",
            ]
          : [
              "deploy",
              ...(args.deploy ? [] : ["--dry-run"]),
              ...(args.secrets ? ["--secrets-file", args.secrets] : []),
            ];
      if (mode === "local" && digest)
        await saveProtected(
          join(run, ".dev.vars"),
          `POINTER_API_KEY_SHA256="${digest}"\n`,
        );
      await runNode(
        entry,
        [...command, "--config", join(run, "wrangler.json"), "--no-bundle"],
        run,
      );
      if (mode === "deploy") {
        const result = {
          workerCid: cid,
          appCid: context.appCid,
          name: target.name,
          accountId: target.account_id,
          status: args.deploy ? "deployed" : "dry-run",
        };
        const stream = (text: string) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from(text));
              controller.close();
            },
          });
        await context.output.writeFile(
          ".bundle.yaml",
          stream(
            JSON.stringify({
              name: "IPAB Worker Deployment Result",
              entry: { path: "result.json", contentType: "application/json" },
            }),
          ),
        );
        await context.output.writeFile(
          "result.json",
          stream(JSON.stringify(result)),
        );
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}
