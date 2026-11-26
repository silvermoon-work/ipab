#!/usr/bin/env tsx
/**
 * Operator CLI: keys, certificates, and signed reads/writes.
 *
 *   pnpm cli keygen --subject alice --out .keys/alice.json
 *   pnpm cli certify --issuer .keys/alice.json --subject alice/agent-1 \
 *     --read --write --scope-sub 'alice/agent-*' --days 7 --out .keys/agent-1.json
 *   pnpm cli read  --key .keys/agent-1.json --url http://127.0.0.1:8787
 *   pnpm cli write --key .keys/agent-1.json --value "next target" --if-version 1
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  keyId,
  loadTrustAnchor,
  publicKeyToPem,
  randomBytes,
  toBase64Url,
} from "../src/crypto.ts";
import { issueCertificate } from "../src/certificates.ts";
import type { Certificate } from "../src/protocol.ts";
import {
  normalizeScope,
  subjectMatches,
  type CertificateBody,
  type DelegatedScope,
} from "../src/protocol.ts";
import { AdminClient, PointerClient, PointerApiError } from "../src/client.ts";

/**
 * `@cloudflare/workers-types` declares the global `process` as `any`, and the
 * `node:process` module re-exports that global, so the CLI declares the few
 * Node process APIs it uses explicitly.
 */
interface NodeRuntime {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  exit(code: number): never;
  exitCode: number;
}

const runtime = globalThis as unknown as { process: NodeRuntime };

interface Keystore {
  subject: string;
  publicKey: string;
  privateKey: string;
  certificates: Certificate[];
  metadata?: Record<string, string>;
}

const parseKeystore = (text: string): Keystore => {
  const value: unknown = JSON.parse(text);
  return value as Keystore;
};

const load = async (path: string): Promise<Keystore> =>
  parseKeystore(await readFile(path, "utf8"));

const save = async (path: string, value: Keystore): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  runtime.process.exit(1);
  throw new Error(message);
};

const required = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) fail(`--${name}`);
  return String(value);
};

function requireOption(
  args: Record<string, string | boolean | undefined>,
  name: string,
): string {
  return required(args[name], name + " is required");
}

async function cmdKeygen(
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  const subject = requireOption(args, "subject");
  const out = requireOption(args, "out");
  const pair = await generateKeyPair();
  await save(out, {
    subject,
    publicKey: pair.publicRaw,
    privateKey: pair.privatePkcs8,
    certificates: [],
  });
  console.log(`wrote ${out}`);
  console.log(`subject: ${subject}`);
  console.log(`public key (raw base64url): ${pair.publicRaw}`);
  console.log(`public key (PEM):\n${publicKeyToPem(pair.publicRaw)}`);
}

async function cmdCertify(
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  const issuerPath = requireOption(args, "issuer");
  const out = requireOption(args, "out");
  const issuer = await load(issuerPath);

  const parent = issuer.certificates[0];
  if (parent && !parent.body.ca) {
    fail(
      `${issuerPath} holds a leaf certificate; it is not allowed to issue certificates`,
    );
  }

  // The holder keystore may already exist (keygen first) or be created here.
  const keyPath = (args["subject-key"] as string | undefined) ?? out;
  let holder: Keystore;
  try {
    holder = await load(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    holder = { subject: "", publicKey: "", privateKey: "", certificates: [] };
  }
  if (!holder.privateKey) {
    const pair = await generateKeyPair();
    holder = {
      subject: requireOption(args, "subject"),
      publicKey: pair.publicRaw,
      privateKey: pair.privatePkcs8,
      certificates: [],
    };
  }

  const subject = (args.subject as string | undefined) ?? holder.subject;
  if (!subject)
    fail("--subject is required when the holder keystore has no subject");
  if (subject !== holder.subject) {
    fail(
      `holder keystore belongs to "${holder.subject}", refusing to issue for "${subject}"`,
    );
  }

  const days = Number(args.days ?? 7);
  if (!Number.isFinite(days) || days <= 0) fail("--days must be positive");

  const scope: DelegatedScope = normalizeScope({
    read: args.read === true,
    write: args.write === true,
    ...(typeof args["scope-sub"] === "string"
      ? { sub: args["scope-sub"] }
      : {}),
  });
  if (!scope.read && !scope.write) fail("specify --read and/or --write");
  if (scope.sub !== undefined && !subjectMatches(scope.sub, subject)) {
    fail(`--scope-sub "${scope.sub}" does not cover subject "${subject}"`);
  }

  const now = Math.floor(Date.now() / 1000);
  const body: CertificateBody = {
    v: 1,
    sub: subject,
    pub: holder.publicKey,
    scope,
    iss: issuer.subject,
    iss_pub: issuer.publicKey,
    kid: await keyId(holder.publicKey),
    cid: toBase64Url(randomBytes(16)),
    iat: Math.max(now - 5, parent?.body.iat ?? 0),
    exp: Math.min(
      now + Math.floor(days * 86400),
      parent?.body.exp ?? Number.MAX_SAFE_INTEGER,
    ),
    ca: args.ca === true,
    ...(args.meta ? { meta: { note: String(args.meta) } } : {}),
  };
  if (body.exp <= body.iat)
    fail("certificate would already be expired (check --days / parent expiry)");

  const certificate = await issueCertificate(
    body,
    await importPrivateKeyPkcs8(issuer.privateKey),
  );
  await save(out, {
    subject,
    publicKey: holder.publicKey,
    privateKey: holder.privateKey,
    certificates: [certificate, ...issuer.certificates],
  });
  console.log(`wrote ${out}`);
  console.log(`certificate id: ${body.cid}`);
  console.log(`subject: ${subject}`);
  console.log(`scope: ${JSON.stringify(scope)}`);
  console.log(`valid until: ${new Date(body.exp * 1000).toISOString()}`);
}

function makeClient(
  args: Record<string, string | boolean | undefined>,
): PointerClient {
  const keyPath = requireOption(args, "key");
  const url =
    (typeof args.url === "string" ? args.url : undefined) ??
    runtime.process.env["POINTER_URL"] ??
    "http://127.0.0.1:8787";
  const keystore = parseKeystore(readFileSync(keyPath, "utf8"));
  return new PointerClient({
    baseUrl: url,
    signer: {
      privateKey: keystore.privateKey,
      certificates: keystore.certificates,
      ...(keystore.certificates.length === 0
        ? { subject: keystore.subject }
        : {}),
    },
  });
}

async function cmdRead(
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  const client = makeClient(args);
  const result = await client.read();
  console.log(JSON.stringify(result, null, 2));
}

function adminClient(
  args: Record<string, string | boolean | undefined>,
): AdminClient {
  const keyPath = requireOption(args, "key");
  const url =
    (typeof args.url === "string" ? args.url : undefined) ??
    runtime.process.env["POINTER_URL"] ??
    "http://127.0.0.1:8787";
  const keystore = parseKeystore(readFileSync(keyPath, "utf8"));
  return new AdminClient({
    baseUrl: url,
    signer: {
      privateKey: keystore.privateKey,
      subject: keystore.subject || "admin",
    },
  });
}

async function pubkeyOption(
  args: Record<string, string | boolean | undefined>,
): Promise<string> {
  const raw = args.pubkey;
  if (typeof raw === "string") return (await loadTrustAnchor(raw)).publicRaw;
  const fileRaw = args["pubkey-file"];
  if (typeof fileRaw !== "string")
    fail("provide --pubkey <key> or --pubkey-file <keystore.json>");
  const file = fileRaw as string;
  const keystore = parseKeystore(readFileSync(file, "utf8"));
  if (!keystore.publicKey) fail(`${file} has no publicKey field`);
  return (await loadTrustAnchor(keystore.publicKey)).publicRaw;
}

async function cmdAdmin(
  sub: string | undefined,
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  const client = adminClient(args);
  switch (sub) {
    case "list":
      console.log(JSON.stringify(await client.list(), null, 2));
      return;
    case "create":
      console.log(
        JSON.stringify(
          await client.create(
            requireOption(args, "name"),
            await pubkeyOption(args),
          ),
          null,
          2,
        ),
      );
      return;
    case "rotate":
      console.log(
        JSON.stringify(
          await client.rotate(
            requireOption(args, "name"),
            await pubkeyOption(args),
          ),
          null,
          2,
        ),
      );
      return;
    case "delete":
      console.log(
        JSON.stringify(
          await client.remove(requireOption(args, "name")),
          null,
          2,
        ),
      );
      return;
    case "get":
      console.log(
        JSON.stringify(await client.get(requireOption(args, "name")), null, 2),
      );
      return;
    default:
      fail(
        "usage: cli admin <list|create|rotate|delete|get> --key <admin.json> [--name N] [--pubkey K|--pubkey-file F] [--url URL]",
      );
  }
}

async function cmdWrite(
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  const client = makeClient(args);
  const value = requireOption(args, "value");
  const idempotencyKey = args["idempotency-key"] as string | undefined;
  const ifVersionRaw = args["if-version"];
  const result =
    ifVersionRaw === undefined
      ? await client.create(value, idempotencyKey ? { idempotencyKey } : {})
      : await client.write(value, {
          ifVersion: Number(ifVersionRaw),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdShow(
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  const keystore = await load(requireOption(args, "key"));
  console.log(JSON.stringify(keystore, null, 2));
}

async function cmdAnchor(
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  const text = requireOption(args, "key");
  const anchor = await loadTrustAnchor(text);
  console.log(`raw base64url: ${anchor.publicRaw}`);
  console.log(`kid: ${await keyId(anchor.publicRaw)}`);
  console.log(`PEM:\n${publicKeyToPem(anchor.publicRaw)}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = runtime.process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      subject: { type: "string" },
      out: { type: "string" },
      issuer: { type: "string" },
      "subject-key": { type: "string" },
      key: { type: "string" },
      url: { type: "string" },
      value: { type: "string" },
      "if-version": { type: "string" },
      "idempotency-key": { type: "string" },
      "scope-sub": { type: "string" },
      meta: { type: "string" },
      days: { type: "string" },
      name: { type: "string" },
      pubkey: { type: "string" },
      "pubkey-file": { type: "string" },
      read: { type: "boolean" },
      write: { type: "boolean" },
      ca: { type: "boolean" },
    },
    allowPositionals: true,
  });

  try {
    switch (command) {
      case "keygen":
        await cmdKeygen(values);
        return;
      case "certify":
        await cmdCertify(values);
        return;
      case "read":
        await cmdRead(values);
        return;
      case "write":
        await cmdWrite(values);
        return;
      case "show":
        await cmdShow(values);
        return;
      case "anchor":
        await cmdAnchor(values);
        return;
      case "admin":
        await cmdAdmin(positionals[0], values);
        return;
      default:
        console.log(`usage:
  cli keygen  --subject <id> --out <file>
  cli certify --issuer <root.json> --subject <id> --subject-key <file> --out <file>
              [--read] [--write] [--scope-sub <glob>] [--days N] [--ca]
  cli read    --key <file> [--url http://127.0.0.1:8787]
  cli write   --key <file> --value <string> [--if-version N] [--idempotency-key K] [--url ...]
  cli show    --key <file>
  cli anchor  --key <base64url|pem|jwk>

  cli admin list   --key <admin.json> [--url ...]
  cli admin get    --key <admin.json> --name <name> [--url ...]
  cli admin create --key <admin.json> --name <name> (--pubkey <key>|--pubkey-file <keystore>) [--url ...]
  cli admin rotate --key <admin.json> --name <name> (--pubkey <key>|--pubkey-file <keystore>) [--url ...]
  cli admin delete --key <admin.json> --name <name> [--url ...]`);
        if (command) runtime.process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof PointerApiError) {
      console.error(`HTTP ${err.status} ${err.code}: ${err.message}`);
      if (err.current) console.error(`current: ${JSON.stringify(err.current)}`);
      runtime.process.exit(1);
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

void main();
