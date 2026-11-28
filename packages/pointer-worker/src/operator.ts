import { parseArgs } from "node:util";
import {
  ScopeClient,
  issueScopeCertificate,
  uniqueId,
  type Json,
  type ScopeSigner,
} from "@ipab/bundle/pointer/scope";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  randomBytes,
  sha256Hex,
  toBase64Url,
} from "./crypto.ts";
import {
  canonicalService,
  isCanonicalPublicKey,
  POINTER_ID_PATTERN,
} from "./protocol.ts";
import { readProtected, saveProtected } from "./protected-files.ts";
import { runtime } from "./node-runtime.ts";
export { runtime } from "./node-runtime.ts";
export interface OperatorIO {
  env?: Record<string, string | undefined>;
  print?: (message: string) => void;
  fetch?: typeof fetch;
  read?: (path: string) => Promise<string>;
  save?: (path: string, text: string) => Promise<void>;
}
export async function runOperator(
  argv: string[],
  io: OperatorIO = {},
): Promise<void> {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!,
      value = argv[index + 1];
    if (
      value !== undefined &&
      ((["--scope", "--id", "--subject"].includes(option) &&
        POINTER_ID_PATTERN.test(value)) ||
        (option === "--write" &&
          value.split(",").every((id) => POINTER_ID_PATTERN.test(id))) ||
        (option === "--idempotency-key" &&
          /^[A-Za-z0-9._-]{16,128}$/.test(value)))
    ) {
      args.push(`${option}=${value}`);
      index++;
    } else args.push(option);
  }
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "key",
        "issuer",
        "subject",
        "write",
        "out",
        "service",
        "config-file",
        "api-key-file",
        "scope",
        "id",
        "value",
        "if-cid",
        "idempotency-key",
      ].map((key) => [key, { type: "string" as const }]),
    ),
  });
  const command = positionals[0],
    print = io.print ?? console.log,
    read = io.read ?? readProtected,
    save = io.save ?? saveProtected;
  const required = (key: string): string => {
    const value = values[key];
    if (typeof value !== "string" || !value)
      throw new Error(`--${key} required`);
    return value;
  };
  if (command === "api-key") {
    const key = toBase64Url(randomBytes(32));
    print(key);
    print(
      `Set Wrangler secret POINTER_API_KEY_SHA256 to: ${await sha256Hex(key)}`,
    );
    print("Protect the first line; never log or put it in command arguments.");
    return;
  }
  if (command === "keygen") {
    const pair = await generateKeyPair();
    await save(
      required("out"),
      JSON.stringify({
        publicKey: pair.publicRaw,
        privateKey: pair.privatePkcs8,
      }) + "\n",
    );
    print(`public key: ${pair.publicRaw}`);
    return;
  }
  if (
    ![
      "certify",
      "create-scope",
      "create",
      "read",
      "write",
      "freeze",
      "delete",
    ].includes(command ?? "")
  )
    throw new Error(
      "commands: api-key, keygen, certify, create-scope, create, read, write, freeze, delete",
    );
  let config: Record<string, unknown> = {};
  if (typeof values["config-file"] === "string") {
    const value: unknown = JSON.parse(await read(values["config-file"]));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("protected config must be an object");
    config = value as Record<string, unknown>;
  }
  const env = io.env ?? runtime.process.env;
  const configuredService =
    env.IPAB_POINTERS_SERVICE ?? config["pointers.service"];
  const service = canonicalService(
    typeof values.service === "string"
      ? values.service
      : typeof configuredService === "string"
        ? configuredService
        : "",
  );
  const load = async (path: string): Promise<ScopeSigner> => {
    const value = JSON.parse(await read(path)) as ScopeSigner | null;
    if (
      !value ||
      !isCanonicalPublicKey(value.publicKey) ||
      typeof value.privateKey !== "string"
    )
      throw new Error("invalid protected signing keystore");
    return value;
  };
  if (command === "certify") {
    const owner = await load(required("issuer"));
    if (owner.certificate) throw new Error("only Owner can certify");
    const certificate = await issueScopeCertificate(
      {
        v: 1,
        service,
        scopeId: required("scope"),
        subject: required("subject"),
        write: required("write").split(","),
      },
      await importPrivateKeyPkcs8(owner.privateKey),
    );
    await save(required("out"), JSON.stringify(certificate) + "\n");
    print(
      "Exact-ID write certificate saved; no expiry or management permissions.",
    );
    return;
  }
  const signer = command === "read" ? undefined : await load(required("key"));
  const apiKey =
    typeof values["api-key-file"] === "string"
      ? (await read(values["api-key-file"])).trim()
      : (env.IPAB_POINTERS_API_KEY ??
        (typeof config["pointers.apiKey"] === "string"
          ? config["pointers.apiKey"]
          : undefined));
  if (
    command === "create-scope" &&
    configuredService &&
    configuredService !== service
  )
    throw new Error("creation API key is bound to its configured service");
  const client = new ScopeClient({
    service,
    ...(signer ? { signer } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  const key =
    typeof values["idempotency-key"] === "string"
      ? values["idempotency-key"]
      : uniqueId();
  if (command === "create-scope")
    print(JSON.stringify(await client.createScope(key)));
  else if (command === "create")
    print(
      JSON.stringify(
        await client.create(
          required("scope"),
          JSON.parse(required("value")) as Json,
          key,
        ),
      ),
    );
  else if (command === "read")
    print(JSON.stringify(await client.read(required("scope"), required("id"))));
  else if (command === "write")
    print(
      JSON.stringify(
        await client.write(
          required("scope"),
          required("id"),
          JSON.parse(required("value")) as Json,
          required("if-cid"),
          key,
        ),
      ),
    );
  else if (command === "freeze")
    print(
      JSON.stringify(
        await client.freeze(required("scope"), required("id"), key),
      ),
    );
  else
    print(
      JSON.stringify(
        await client.delete(required("scope"), required("id"), key),
      ),
    );
}
