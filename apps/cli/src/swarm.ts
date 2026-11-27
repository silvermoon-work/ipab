import { mkdir, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { CarBlockIterator } from "@ipld/car/iterator";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { encodeSchema, openBundle, type BundleManifest } from "@ipab/bundle";
import {
  encodeBundleCar,
  memoryTree,
  streamChunks,
} from "@ipab/bundle-builder";
import type { IpfsStore } from "@ipab/ipfs-store";
import {
  PointerClient,
  PointerApiError,
  type ReadResult,
} from "@ipab/bundle/pointer/client";
import {
  canonicalService,
  POINTER_ID_PATTERN,
} from "@ipab/bundle/pointer/protocol";
import {
  encodeCertificate,
  issueCertificate,
  verifyMemberCertificate,
} from "@ipab/bundle/pointer/certificates";
import {
  importPrivateKeyPkcs8,
  importPublicKeyRaw,
  signEd25519,
  verifyEd25519,
  randomBytes,
  toBase64Url,
} from "@ipab/bundle/pointer/crypto";
import type { Certificate } from "@ipab/bundle/pointer/protocol";
import { HostError, object, message } from "./errors.js";
import {
  accountIdentity,
  protectedPath,
  secureNew,
  type Identity,
} from "./identity.js";
import { nodeError } from "./authoring.js";
import { bundleJson, provideContent } from "./content-provider.js";
import { bytes, relativePath } from "./space.js";
import { publicUrl } from "./config.js";
import { appSchemaCid } from "./app-definition.js";
import { State } from "./state.js";

const cidField = { type: "string", minLength: 1, maxLength: 128 } as const;
function definition(
  name: string,
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): BundleManifest {
  return {
    name,
    description: "",
    entry: {
      path: "entry.json",
      contentType: "application/json",
      schema: {
        type: "object",
        additionalProperties: false,
        required,
        properties,
      },
    },
  };
}
export const swarmType = definition("IPAB Swarm", {
  service: { type: "string" },
  variable: { type: "string" },
  owner: { type: "string" },
});
export const artifactType = definition(
  "IPAB Artifact",
  {
    value: cidField,
    previous: cidField,
    timestamp: { type: "string", format: "date-time" },
  },
  ["value", "timestamp"],
);
export const requestType = definition("IPAB Membership Request", {
  swarm: cidField,
  member: { type: "string" },
  requestId: { type: "string" },
  iat: { type: "integer" },
  exp: { type: "integer" },
  signature: { type: "string" },
});
export const responseType = definition("IPAB Membership Response", {
  swarm: cidField,
  request: cidField,
  certificate: { type: "object" },
});
export interface Descriptor {
  service: string;
  variable: string;
  owner: string;
}
interface MembershipRequest {
  swarm: string;
  member: string;
  requestId: string;
  iat: number;
  exp: number;
  signature: string;
}
export interface Artifact {
  value: string;
  previous?: string;
  timestamp: string;
}
export interface Snapshot {
  v: 1;
  properties: { name: string; description: string };
  names: Record<string, CID>;
}
export interface SwarmContext {
  store: IpfsStore;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  provider: string;
  fetch?: typeof fetch;
  pointerService?: string;
  pointerApiKey?: string;
  state?: State;
  cacheTtl?: number;
  forceRefresh?: boolean;
  diagnostic?: (text: string) => void;
}
function withState<T>(
  context: SwarmContext,
  operation: (state: State) => T,
): T {
  if (context.state) return operation(context.state);
  const state = new State(context.stateDir);
  try {
    return operation(state);
  } finally {
    state.close();
  }
}
async function requestPointer<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (cause) {
      if (
        attempt >= 2 ||
        !(cause instanceof Error) ||
        !["TypeError", "AbortError", "TimeoutError"].includes(cause.name)
      )
        throw cause;
    }
  }
}
const serviceFetch: typeof fetch = (input, options) =>
  fetch(input, {
    ...options,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
interface BoundPointer {
  read(): Promise<ReadResult>;
  write(
    root: string,
    revision: string,
    idempotencyKey: string,
  ): Promise<ReadResult>;
}
function bindPointer(
  context: SwarmContext,
  data: Descriptor,
  identity: Identity,
  certificate?: Certificate,
): BoundPointer {
  const client = new PointerClient({
    service: data.service,
    signer: {
      privateKey: identity.privateKey,
      publicKey: identity.publicKey,
      ...(certificate ? { certificate } : {}),
    },
    fetch: context.fetch ?? serviceFetch,
  });
  return {
    read: () => requestPointer(() => client.read(data.variable)),
    write: (root, revision, idempotencyKey) =>
      requestPointer(() =>
        client.write(data.variable, root, {
          ifRevision: revision,
          idempotencyKey,
        }),
      ),
  };
}
export async function typedJson<T>(
  store: IpfsStore,
  cid: string,
  type: BundleManifest,
): Promise<T> {
  const { bundle, value } = await bundleJson(store, cid);
  if (bundle.schemaKey !== (await encodeSchema(type)).cid.toString())
    throw new HostError(`Expected exact ${type.name} Bundle type.`);
  return value as T;
}
export async function jsonBundle(
  store: IpfsStore,
  type: BundleManifest,
  value: unknown,
): Promise<string> {
  const encoded = await encodeBundleCar(
    memoryTree(
      new Map([
        [".bundle.yaml", new TextEncoder().encode(stringify(type))],
        ["entry.json", new TextEncoder().encode(`${JSON.stringify(value)}\n`)],
      ]),
    ),
  );
  try {
    const iterator = await CarBlockIterator.fromIterable(
      streamChunks(encoded.stream),
    );
    for await (const block of iterator) await store.put(block.cid, block.bytes);
    return encoded.cid.toString();
  } finally {
    await encoded.close();
  }
}
export async function descriptor(
  store: IpfsStore,
  cid: string,
): Promise<Descriptor> {
  const data = await typedJson<Descriptor>(store, cid, swarmType);
  return validateDescriptor(data);
}
async function validateDescriptor(data: Descriptor): Promise<Descriptor> {
  data.service = publicUrl(data.service).replace(/\/$/, "");
  const url = new URL(data.service);
  if (
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new HostError(
      "Swarm service must be an HTTPS origin or isolated loopback HTTP origin.",
    );
  if (!POINTER_ID_PATTERN.test(data.variable))
    throw new HostError("Invalid service pointer ID.");
  await importPublicKeyRaw(data.owner);
  return data;
}
const target = (data: Descriptor) =>
  `${data.service}/v1/pointers/${data.variable}`;
const now = () => Math.floor(Date.now() / 1000);
function requestMessage(
  data: Descriptor,
  request: Omit<MembershipRequest, "signature">,
): string {
  return `IPAB-MEMBERSHIP/1\n${target(data)}\n${JSON.stringify({ swarm: request.swarm, member: request.member, requestId: request.requestId, iat: request.iat, exp: request.exp })}`;
}
async function verifiedRequest(
  store: IpfsStore,
  cid: string,
): Promise<{ request: MembershipRequest; data: Descriptor }> {
  const request = await typedJson<MembershipRequest>(store, cid, requestType);
  const data = await descriptor(store, request.swarm);
  if (
    request.iat > now() + 60 ||
    request.exp <= now() ||
    request.exp <= request.iat ||
    request.exp - request.iat > 7 * 86400 ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId)
  )
    throw new HostError("Membership request is expired or invalid.");
  if (
    !(await verifyEd25519(
      await importPublicKeyRaw(request.member),
      request.signature,
      requestMessage(data, request),
    ))
  )
    throw new HostError("Membership request possession proof is invalid.");
  return { request, data };
}
async function credentialDirectory(context: SwarmContext): Promise<string> {
  const path = join(context.stateDir, "swarm-credentials");
  try {
    await lstat(path);
  } catch (cause) {
    if (!nodeError(cause, "ENOENT")) throw cause;
    await mkdir(path, { mode: 0o700 });
    await secureNew(path, true);
  }
  await protectedPath(path, true);
  return path;
}
async function save(
  context: SwarmContext,
  name: string,
  value: unknown,
): Promise<void> {
  const path = join(await credentialDirectory(context), name);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await secureNew(path);
}
async function saved(context: SwarmContext, name: string): Promise<unknown> {
  const path = join(await credentialDirectory(context), name);
  await protectedPath(path);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
export async function pointer(
  context: SwarmContext,
  swarm: string,
  certificate?: Certificate,
): Promise<BoundPointer> {
  const data = await descriptor(context.store, swarm);
  const identity = await accountIdentity(context.env);
  return authenticatedPointer(context, swarm, data, identity, certificate);
}
async function authenticatedPointer(
  context: SwarmContext,
  swarm: string,
  data: Descriptor,
  identity: Identity,
  certificate?: Certificate,
): Promise<BoundPointer> {
  if (identity.publicKey === data.owner && certificate === undefined)
    return bindPointer(context, data, identity);
  const cert =
    certificate ??
    ((await saved(context, `${swarm}.json`)) as { certificate: Certificate })
      .certificate;
  const verified = await verifyMemberCertificate(
    encodeCertificate(cert),
    await importPublicKeyRaw(data.owner),
    data.owner,
    data.service,
    data.variable,
    now(),
  );
  if (verified.member !== identity.publicKey)
    throw new HostError(
      "Membership certificate does not match this account, swarm, owner or validity window.",
    );
  if (identity.publicKey === data.owner)
    return bindPointer(context, data, identity);
  return bindPointer(context, data, identity, cert);
}
export async function writeSnapshot(
  store: IpfsStore,
  snapshot: Snapshot,
): Promise<string> {
  const encoded = dagCbor.encode(snapshot);
  const cid = CID.createV1(dagCbor.code, await sha256.digest(encoded));
  await store.put(cid, encoded);
  return cid.toString();
}
export async function readSnapshot(
  store: IpfsStore,
  root: string,
): Promise<Snapshot> {
  const cid = CID.parse(root);
  if (cid.code !== dagCbor.code)
    throw new HostError("HEAD must reference a DAG-CBOR snapshot.");
  const publication = object(
    dagCbor.decode(await store.block.get(root)),
    "publication record",
  );
  const stateCid = CID.asCID(publication.state);
  if (
    publication.v !== 1 ||
    !stateCid ||
    Object.keys(publication).some(
      (key) => !["v", "state", "previous"].includes(key),
    ) ||
    (publication.previous !== undefined && !CID.asCID(publication.previous))
  )
    throw new HostError(
      "HEAD must reference a verified publication linking State and optional previous publication.",
    );
  return decodeSnapshot(await store.block.get(stateCid.toString()));
}
function decodeSnapshot(bytes: Uint8Array): Snapshot {
  const value = object(dagCbor.decode(bytes), "swarm snapshot");
  const properties = object(value.properties, "swarm properties");
  const names = object(value.names, "swarm Names");
  if (
    value.v !== 1 ||
    typeof properties.name !== "string" ||
    typeof properties.description !== "string" ||
    Object.keys(value).some(
      (key) => !["v", "names", "properties"].includes(key),
    )
  )
    throw new HostError("Invalid swarm snapshot.");
  for (const [name, link] of Object.entries(names)) {
    formalName(name);
    if (!CID.asCID(link))
      throw new HostError("Snapshot Name targets must be CID links.");
  }
  return value as unknown as Snapshot;
}
export interface SwarmHeader {
  head: ReadResult;
  snapshot: Snapshot;
  source: "cache" | "network";
  verifiedAt: string;
}
export async function swarmHeader(
  context: SwarmContext,
  swarm: string,
  force = context.forceRefresh ?? false,
): Promise<SwarmHeader> {
  swarm = CID.parse(swarm).toV1().toString();
  const identity = await accountIdentity(context.env);
  const ttl = context.cacheTtl ?? 300;
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 86400)
    throw new HostError(
      "swarm.cacheTtl requires an integer number of seconds from 0 to 86400.",
    );
  const cached = force
    ? undefined
    : withState(context, (state) =>
        state.swarmHeader(identity.publicKey, swarm),
      );
  if (cached !== undefined) {
    const value = object(cached, "swarm header cache");
    if (
      typeof value.root !== "string" ||
      CID.parse(value.root).code !== dagCbor.code ||
      typeof value.revision !== "string" ||
      !value.revision ||
      typeof value.etag !== "string" ||
      typeof value.verifiedAt !== "number" ||
      !Number.isSafeInteger(value.verifiedAt) ||
      value.verifiedAt < 0 ||
      typeof value.snapshot !== "string" ||
      Buffer.from(value.snapshot, "base64").toString("base64") !==
        value.snapshot
    )
      throw new HostError(
        "Invalid persisted swarm header cache; retry with --force to replace it.",
      );
    const snapshot = decodeSnapshot(Buffer.from(value.snapshot, "base64"));
    const cachedDescriptor = object(
      value.descriptor,
      "cached swarm descriptor",
    );
    if (
      typeof cachedDescriptor.service !== "string" ||
      typeof cachedDescriptor.variable !== "string" ||
      typeof cachedDescriptor.owner !== "string"
    )
      throw new HostError(
        "Invalid cached swarm descriptor; retry with --force to replace it.",
      );
    const data = await validateDescriptor({
      service: cachedDescriptor.service,
      variable: cachedDescriptor.variable,
      owner: cachedDescriptor.owner,
    });
    const age = Date.now() - value.verifiedAt;
    if (age >= 0 && age < ttl * 1000) {
      await authenticatedPointer(context, swarm, data, identity);
      return {
        head: { root: value.root, revision: value.revision, etag: value.etag },
        snapshot,
        source: "cache",
        verifiedAt: new Date(value.verifiedAt).toISOString(),
      };
    }
  }
  const data = await descriptor(context.store, swarm);
  const client = await authenticatedPointer(context, swarm, data, identity);
  context.diagnostic?.(`Refreshing swarm HEAD ${swarm}...`);
  const head = await client.read();
  const snapshot = await readSnapshot(context.store, head.root);
  const verifiedAt = Date.now();
  withState(context, (state) => {
    state.saveSwarmHeader(identity.publicKey, swarm, {
      ...head,
      descriptor: data,
      snapshot: Buffer.from(dagCbor.encode(snapshot)).toString("base64"),
      verifiedAt,
    });
  });
  return {
    head,
    snapshot,
    source: "network",
    verifiedAt: new Date(verifiedAt).toISOString(),
  };
}
export async function addSwarm(
  context: SwarmContext,
  swarm: string,
  alias?: string,
): Promise<void> {
  swarm = CID.parse(swarm).toV1().toString();
  if (alias !== undefined)
    withState(context, (state) => {
      state.checkSwarmAlias(alias, swarm);
    });
  await swarmHeader(context, swarm, true);
  withState(context, (state) => state.registerSwarm(swarm, alias));
}
export async function searchNames(
  context: SwarmContext,
  query: string,
  swarms: readonly { cid: string; alias: string | null }[],
) {
  if (
    !query ||
    query.length > 256 ||
    [...query].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new HostError(
      "Search query must be 1..256 characters without control characters.",
      2,
    );
  const matches: {
    swarm: string;
    alias: string | null;
    name: string;
    reference: string;
    targetCid: string;
  }[] = [];
  const searched: {
    cid: string;
    source: "cache" | "network";
    root: string;
    revision: string;
    verifiedAt: string;
  }[] = [];
  for (const swarm of [...swarms].sort((a, b) =>
    a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0,
  )) {
    let header: SwarmHeader;
    try {
      header = await swarmHeader(context, swarm.cid);
    } catch (cause) {
      throw new HostError(
        `Could not search swarm "${swarm.alias ?? swarm.cid}": ${message(cause)}. Search was not completed.`,
      );
    }
    searched.push({
      cid: swarm.cid,
      source: header.source,
      root: header.head.root,
      revision: header.head.revision,
      verifiedAt: header.verifiedAt,
    });
    for (const name of Object.keys(header.snapshot.names).sort())
      if (name.toLowerCase().includes(query.toLowerCase()))
        matches.push({
          swarm: swarm.cid,
          alias: swarm.alias,
          name,
          reference: `name:${name}`,
          targetCid: header.snapshot.names[name]!.toString(),
        });
  }
  return { matches, swarms: searched };
}
async function publication(
  store: IpfsStore,
  state: string,
  previous?: string,
): Promise<string> {
  const bytes = dagCbor.encode({
    v: 1,
    state: CID.parse(state),
    ...(previous ? { previous: CID.parse(previous) } : {}),
  });
  const cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
  await store.put(cid, bytes);
  return cid.toString();
}
async function saveCreation(
  context: SwarmContext,
  operation: string,
  record: unknown,
): Promise<void> {
  const directory = await credentialDirectory(context);
  const target = join(directory, `creation-${operation}.json`);
  const temporary = join(directory, `.creation-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await secureNew(temporary);
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } finally {
    await handle.close();
    await unlink(temporary).catch((cause: unknown) => {
      if (!nodeError(cause, "ENOENT"))
        return Promise.reject(
          cause instanceof Error
            ? cause
            : new HostError("Owned creation temporary-file cleanup failed."),
        );
      return undefined;
    });
  }
}
export async function createSwarm(
  context: SwarmContext,
  options: {
    service?: string;
    resume?: string;
    properties?: { name: string; description: string };
    alias?: string;
  } = {},
): Promise<string> {
  if (options.alias !== undefined && options.resume === undefined)
    withState(context, (state) => {
      state.checkSwarmAlias(options.alias!);
    });
  const cfg = {
    service: context.pointerService,
    apiKey: context.pointerApiKey,
  };
  if (!cfg.service || !cfg.apiKey)
    throw new HostError(
      "Configure protected pointers.service and pointers.apiKey via safe stdin before creating a swarm.",
    );
  if (options.service && canonicalService(options.service) !== cfg.service)
    throw new HostError(
      "Creation API key cannot be sent outside its explicitly configured origin.",
    );
  const identity = await accountIdentity(context.env, true);
  const operation = options.resume ?? toBase64Url(randomBytes(18));
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(operation))
    throw new HostError("Invalid saved creation operation.");
  let record: {
    origin: string;
    owner: string;
    root: string;
    createdAt: number;
    id?: string;
    cid?: string;
  };
  if (options.resume) {
    const value = object(
      await saved(context, `creation-${operation}.json`),
      "saved creation",
    );
    if (
      value.origin !== cfg.service ||
      value.owner !== identity.publicKey ||
      typeof value.root !== "string" ||
      !Number.isSafeInteger(value.createdAt) ||
      (value.id !== undefined && typeof value.id !== "string") ||
      (value.cid !== undefined && typeof value.cid !== "string")
    )
      throw new HostError(
        "Saved creation does not match this account and configured service.",
      );
    record = value as typeof record;
    if (options.alias !== undefined)
      withState(context, (state) => {
        state.checkSwarmAlias(options.alias!, record.cid);
      });
    if (!record.id && Date.now() - record.createdAt >= 10 * 60 * 1000)
      throw new HostError(
        "Unconfirmed creation is beyond the service's minimum idempotency window. Ask the operator to recover it; do not allocate another pointer.",
      );
  } else {
    const state = await writeSnapshot(context.store, {
      v: 1,
      properties: options.properties ?? { name: "", description: "" },
      names: {},
    });
    record = {
      origin: cfg.service,
      owner: identity.publicKey,
      root: await publication(context.store, state),
      createdAt: Date.now(),
    };
    await saveCreation(context, operation, record);
  }
  try {
    await provideContent(
      context.store,
      [record.root],
      context.provider,
      context.fetch,
    );
    if (!record.id) {
      const client = new PointerClient({
        service: cfg.service,
        apiKey: cfg.apiKey,
        signer: {
          privateKey: identity.privateKey,
          publicKey: identity.publicKey,
        },
        fetch: context.fetch ?? serviceFetch,
      });
      record.id = (
        await requestPointer(() =>
          client.create(record.root, { idempotencyKey: operation }),
        )
      ).id;
      await saveCreation(context, operation, record);
    }
    const data: Descriptor = {
      service: cfg.service,
      variable: record.id,
      owner: identity.publicKey,
    };
    const cid = await jsonBundle(context.store, swarmType, data);
    await provideContent(
      context.store,
      [cid, record.root],
      context.provider,
      context.fetch,
    );
    record.cid = cid;
    await saveCreation(context, operation, record);
    await addSwarm(context, cid, options.alias);
    return cid;
  } catch (cause) {
    throw new HostError(
      `Swarm creation was not confirmed: ${message(cause)}. ${record.id ? `Pointer ${record.id} is saved.` : "The same creation idempotency key is saved."} Recover with ipab swarm create --resume ${operation}; do not allocate a replacement pointer.`,
      1,
      "CREATE_UNCONFIRMED",
      "authorization",
    );
  }
}
export async function requestMembership(
  context: SwarmContext,
  swarm: string,
): Promise<string> {
  const identity = await accountIdentity(context.env, true);
  const data = await descriptor(context.store, swarm);
  const body = {
    swarm: CID.parse(swarm).toV1().toString(),
    member: identity.publicKey,
    requestId: toBase64Url(randomBytes(18)),
    iat: now(),
    exp: now() + 7 * 86400,
  };
  const request: MembershipRequest = {
    ...body,
    signature: await signEd25519(
      await importPrivateKeyPkcs8(identity.privateKey),
      requestMessage(data, body),
    ),
  };
  const cid = await jsonBundle(context.store, requestType, request);
  await provideContent(
    context.store,
    [cid, swarm],
    context.provider,
    context.fetch,
  );
  await save(context, `${cid}.pending.json`, {
    swarm,
    member: identity.publicKey,
  });
  return cid;
}
export async function approveMembership(
  context: SwarmContext,
  requestCid: string,
  seconds = 7 * 86400,
): Promise<string> {
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 30 * 86400)
    throw new HostError("Certificate duration must be 60 seconds to 30 days.");
  const { request, data } = await verifiedRequest(context.store, requestCid);
  const identity = await accountIdentity(context.env);
  if (identity.publicKey !== data.owner)
    throw new HostError("Only this swarm's owner can approve members.");
  const certificate = await issueCertificate(
    {
      v: 2,
      service: data.service,
      pointerId: data.variable,
      owner: data.owner,
      member: request.member,
      cid: toBase64Url(randomBytes(16)),
      iat: now(),
      exp: now() + seconds,
    },
    await importPrivateKeyPkcs8(identity.privateKey),
  );
  const cid = await jsonBundle(context.store, responseType, {
    swarm: request.swarm,
    request: CID.parse(requestCid).toV1().toString(),
    certificate,
  });
  await provideContent(
    context.store,
    [cid, requestCid, request.swarm],
    context.provider,
    context.fetch,
  );
  return cid;
}
export async function joinSwarm(
  context: SwarmContext,
  responseCid: string,
  alias?: string,
): Promise<string> {
  const response = await typedJson<{
    swarm: string;
    request: string;
    certificate: Certificate;
  }>(context.store, responseCid, responseType);
  const { request } = await verifiedRequest(context.store, response.request);
  const identity = await accountIdentity(context.env);
  const pending = object(
    await saved(context, `${response.request}.pending.json`),
    "pending request",
  );
  if (
    request.swarm !== response.swarm ||
    request.member !== identity.publicKey ||
    pending.swarm !== response.swarm ||
    pending.member !== identity.publicKey
  )
    throw new HostError(
      "Response does not match this account's exact pending request and target swarm.",
    );
  const client = await pointer(context, response.swarm, response.certificate);
  if (alias !== undefined)
    withState(context, (state) => {
      state.checkSwarmAlias(alias, response.swarm);
    });
  await client.read();
  try {
    await save(context, `${response.swarm}.json`, {
      certificate: response.certificate,
      request: response.request,
    });
  } catch (cause) {
    if (!nodeError(cause, "EEXIST")) throw cause;
    const previous = object(
      await saved(context, `${response.swarm}.json`),
      "membership",
    );
    if (previous.request !== response.request)
      throw new HostError(
        "An existing membership differs; explicit renewal is outside this MVP.",
      );
  }
  try {
    await addSwarm(context, response.swarm, alias);
  } catch (cause) {
    throw new HostError(
      `Membership certificate was saved, but swarm registration failed: ${message(cause)}. Retry the same response or run ipab swarm add ${response.swarm}.`,
    );
  }
  return response.swarm;
}
export function formalName(name: string): string {
  relativePath(name);
  if (name.length > 256 || name.startsWith("builtin:"))
    throw new HostError("Invalid formal Name.");
  return name;
}
export async function resolveReference(
  context: SwarmContext,
  reference: string,
  swarm: string | undefined,
  local: (reference: string) => string,
  raw = false,
): Promise<{ targetCid: string; cid: string }> {
  let targetCid: string;
  if (reference.startsWith("name:")) {
    if (!swarm)
      throw new HostError("Shared Names require --swarm CID or swarm.default.");
    const name = formalName(reference.slice(5));
    let header = await swarmHeader(context, swarm);
    const lookup = () =>
      Object.hasOwn(header.snapshot.names, name)
        ? header.snapshot.names[name]
        : undefined;
    let link = lookup();
    if (!link && header.source === "cache") {
      header = await swarmHeader(context, swarm, true);
      link = lookup();
    }
    if (!link)
      throw new HostError(
        `Formal Name "${name}" is not present in this swarm after refreshing HEAD.`,
      );
    targetCid = link.toString();
  } else targetCid = local(reference);
  let cid = targetCid;
  const visited = new Set<string>();
  for (let depth = 0; !raw; depth++) {
    if (depth >= 64 || visited.has(cid))
      throw new HostError(
        "Artifact resolution exceeds limits or contains a cycle.",
      );
    visited.add(cid);
    const bundle = await openBundle(CID.parse(cid), {
      resolveCid: (cid) => context.store.block.get(cid.toString()),
    });
    if (bundle.schemaKey !== (await encodeSchema(artifactType)).cid.toString())
      break;
    const artifact = await typedJson<Artifact>(
      context.store,
      cid,
      artifactType,
    );
    cid = CID.parse(artifact.value).toV1().toString();
  }
  return { targetCid, cid };
}
async function dependencies(
  store: IpfsStore,
  root: string,
  found = new Set<string>(),
): Promise<Set<string>> {
  if (found.has(root)) return found;
  if (found.size >= 256)
    throw new HostError("Publication dependency/history limit exceeded.");
  found.add(root);
  const bundle = await openBundle(CID.parse(root), {
    resolveCid: (cid) => store.block.get(cid.toString()),
  });
  if (bundle.schemaKey === (await encodeSchema(artifactType)).cid.toString()) {
    const node = await typedJson<Artifact>(store, root, artifactType);
    await dependencies(store, node.value, found);
    if (node.previous) await dependencies(store, node.previous, found);
  } else if (bundle.schemaKey === appSchemaCid.toString()) {
    const app = object(
      JSON.parse(
        new TextDecoder().decode(
          await bytes(
            await bundle.readFile(bundle.manifest.entry.path),
            64 * 1024,
          ),
        ),
      ) as unknown,
      "App",
    );
    if (app.source) {
      const source = object(app.source, "App source");
      if (typeof source.cid !== "string")
        throw new HostError("Invalid App source association.");
      await dependencies(store, source.cid, found);
    }
  }
  return found;
}
export async function publish(
  context: SwarmContext,
  content: string,
  options: {
    swarm?: string;
    name?: string;
    expect?: string;
    snapshot?: boolean;
  },
): Promise<string> {
  const roots = await dependencies(context.store, content);
  if (!options.name) {
    if (options.expect || options.snapshot)
      throw new HostError("--expect/--snapshot require --name.");
    await provideContent(
      context.store,
      [...roots],
      context.provider,
      context.fetch,
    );
    return content;
  }
  const name = formalName(options.name);
  if (!options.swarm)
    throw new HostError(
      "Named publication requires --swarm CID or swarm.default.",
    );
  if (options.snapshot && options.expect)
    throw new HostError(
      "Ordinary named snapshots cannot replace an occupied Name.",
    );
  const expected = options.expect
    ? CID.parse(options.expect).toV1().toString()
    : undefined;
  if (expected)
    await typedJson<Artifact>(context.store, expected, artifactType);
  const candidate = options.snapshot
    ? content
    : await jsonBundle(context.store, artifactType, {
        value: content,
        ...(expected ? { previous: expected } : {}),
        timestamp: new Date().toISOString(),
      });
  roots.add(candidate);
  if (expected)
    for (const root of await dependencies(context.store, expected))
      roots.add(root);
  await provideContent(
    context.store,
    [...roots],
    context.provider,
    context.fetch,
  );
  const client = await pointer(context, options.swarm);
  for (let attempt = 0; attempt < 8; attempt++) {
    const head = await client.read();
    const current = await readSnapshot(context.store, head.root);
    if (
      (Object.hasOwn(current.names, name)
        ? current.names[name]?.toString()
        : undefined) !== expected
    )
      throw new HostError(
        `Edit conflict for ${name}; candidate ${candidate} and content ${content} remain retained. Refresh the Name and explicitly choose a baseline.`,
        3,
        "EDIT_CONFLICT",
        "publication",
      );
    const state = await writeSnapshot(context.store, {
      ...current,
      names: { ...current.names, [name]: CID.parse(candidate) },
    });
    const next = await publication(context.store, state, head.root);
    await provideContent(
      context.store,
      [next, ...roots],
      context.provider,
      context.fetch,
    );
    try {
      withState(context, (state) => {
        state.invalidateSwarmHeader(options.swarm!);
      });
      await client.write(next, head.revision, toBase64Url(randomBytes(18)));
      return candidate;
    } catch (cause) {
      if (!(cause instanceof PointerApiError) || cause.status !== 412)
        throw new HostError(
          `HEAD update failed or its result is unknown: ${message(cause)}. Candidate ${candidate} remains retained; authenticate swarm status before retrying.`,
          1,
          "HEAD_UNCONFIRMED",
          "publication",
        );
    }
  }
  throw new HostError(
    `HEAD is busy; candidate ${candidate} remains retained. Retry the same explicit Name baseline.`,
  );
}
