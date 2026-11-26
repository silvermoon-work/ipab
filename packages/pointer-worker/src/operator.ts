import { parseArgs } from "node:util";
import { PointerClient } from "./client.ts";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  randomBytes,
  sha256Hex,
  toBase64Url,
} from "./crypto.ts";
import { issueCertificate } from "./certificates.ts";
import {
  canonicalService,
  isCanonicalPublicKey,
  POINTER_ID_PATTERN,
  type Certificate,
} from "./protocol.ts";
import { readProtected, saveProtected } from "./protected-files.ts";
import { runtime } from "./node-runtime.ts";
export { runtime } from "./node-runtime.ts";

interface Keystore {
  publicKey: string;
  privateKey: string;
  certificate?: Certificate;
}
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
    const option = argv[index]!;
    const value = argv[index + 1];
    if (
      value !== undefined &&
      ((option === "--id" && POINTER_ID_PATTERN.test(value)) ||
        (option === "--idempotency-key" &&
          /^[A-Za-z0-9_-]{16,128}$/.test(value)))
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
        "member-key",
        "out",
        "service",
        "config-file",
        "api-key-file",
        "id",
        "root",
        "if-revision",
        "idempotency-key",
        "days",
      ].map((key) => [key, { type: "string" as const }]),
    ),
  });
  const command = positionals[0];
  const print = io.print ?? console.log;
  const read = io.read ?? readProtected;
  const save = io.save ?? saveProtected;
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
    print(
      "Store the first line in protected pointers.apiKey config or IPAB_POINTERS_API_KEY. Do not log or commit it.",
    );
    return;
  }
  if (command === "keygen") {
    const pair = await generateKeyPair();
    await save(
      required("out"),
      JSON.stringify(
        { publicKey: pair.publicRaw, privateKey: pair.privatePkcs8 },
        null,
        2,
      ) + "\n",
    );
    print(`public key: ${pair.publicRaw}`);
    return;
  }
  if (!["certify", "create", "read", "write"].includes(command ?? "")) {
    throw new Error("commands: api-key, keygen, certify, create, read, write");
  }
  let config: Record<string, unknown> = {};
  if (typeof values["config-file"] === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await read(values["config-file"]));
    } catch {
      throw new Error("config-file must contain valid protected JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("config-file must contain a JSON object");
    config = parsed as Record<string, unknown>;
  }
  const env = io.env ?? runtime.process.env;
  const service = canonicalService(
    typeof values.service === "string"
      ? values.service
      : (env["IPAB_POINTERS_SERVICE"] ??
          (typeof config["pointers.service"] === "string"
            ? config["pointers.service"]
            : "")),
  );
  const id = (): string => {
    const value = required("id");
    if (!POINTER_ID_PATTERN.test(value)) throw new Error("invalid pointer ID");
    return value;
  };
  const load = async (path: string): Promise<Keystore> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await read(path));
    } catch {
      throw new Error("keystore must contain valid protected JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid keystore");
    const record = parsed as Record<string, unknown>;
    if (
      !isCanonicalPublicKey(record.publicKey) ||
      typeof record.privateKey !== "string" ||
      !record.privateKey
    )
      throw new Error("keystore requires canonical public key and private key");
    return parsed as Keystore;
  };
  if (command === "certify") {
    const owner = await load(required("issuer"));
    if (owner.certificate)
      throw new Error(
        "only an owner account key can certify; member delegation is not supported",
      );
    const member = await load(required("member-key"));
    const days = Number(values.days ?? 7);
    if (
      !Number.isFinite(days) ||
      days <= 0 ||
      !Number.isSafeInteger(Math.floor(days * 86400))
    )
      throw new Error("--days must be positive and finite");
    const now = Math.floor(Date.now() / 1000);
    const exp = now + Math.floor(days * 86400);
    if (!Number.isSafeInteger(exp) || exp <= now)
      throw new Error("--days must yield a positive safe validity period");
    const certificate = await issueCertificate(
      {
        v: 2,
        service,
        pointerId: id(),
        owner: owner.publicKey,
        member: member.publicKey,
        cid: toBase64Url(randomBytes(16)),
        iat: now,
        exp,
      },
      await importPrivateKeyPkcs8(owner.privateKey),
    );
    await save(
      required("out"),
      JSON.stringify({ ...member, certificate }, null, 2) + "\n",
    );
    print(
      "member certificate saved; permits read and write only for this service and pointer",
    );
    return;
  }
  const signer = await load(required("key"));
  const apiKey =
    typeof values["api-key-file"] === "string"
      ? (await read(values["api-key-file"])).trim()
      : (env["IPAB_POINTERS_API_KEY"] ??
        (typeof config["pointers.apiKey"] === "string"
          ? config["pointers.apiKey"]
          : undefined));
  const client = new PointerClient({
    service,
    signer,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  const idempotencyKey =
    typeof values["idempotency-key"] === "string"
      ? values["idempotency-key"]
      : undefined;
  const retry = idempotencyKey === undefined ? {} : { idempotencyKey };
  if (command === "create")
    print(JSON.stringify(await client.create(required("root"), retry)));
  else if (command === "read") print(JSON.stringify(await client.read(id())));
  else
    print(
      JSON.stringify(
        await client.write(id(), required("root"), {
          ifRevision: required("if-revision"),
          ...retry,
        }),
      ),
    );
}
