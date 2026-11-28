import { lstat, open, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { stringify } from "yaml";
import { CarBlockIterator } from "@ipld/car/iterator";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { encodeSchema, openBundle, type BundleType } from "@ipab/bundle";
import {
  encodeBundleCar,
  memoryTree,
  streamChunks,
} from "@ipab/bundle-builder";
import type { IpfsStore } from "@ipab/ipfs-store";
import {
  ScopeClient,
  ScopeApiError,
  issueScopeCertificate,
  uniqueId,
  verifyScopeCertificate,
  valueCid,
  type Variable,
} from "@ipab/bundle/pointer/scope";
import {
  canonicalService,
  isCanonicalPublicKey,
  POINTER_ID_PATTERN,
} from "@ipab/bundle/pointer/protocol";
import {
  importPrivateKeyPkcs8,
  importPublicKeyRaw,
  keyId,
  signEd25519,
  verifyEd25519,
} from "@ipab/bundle/pointer/crypto";
import { HostError, object, message } from "./errors.js";
import { accountIdentity, type Identity } from "./identity.js";
import { bundleJson, provideContent } from "./content-provider.js";
import { bytes, relativePath } from "./space.js";
import { appSchemaCid } from "./app-definition.js";
import { State } from "./state.js";
import {
  privateDirectory,
  readPrivate,
  withPrivateLock,
  writePrivate,
} from "./swarm-files.js";
import {
  encryptionIdentity,
  openApproval,
  sealApproval,
  type EncryptionIdentity,
  type Envelope,
  type EnvelopeBinding,
  type MembershipSecret,
  parseEnvelope,
} from "./swarm-envelope.js";
import {
  kuboSource,
  peerId,
  peerProof,
  prepareNode,
  startNode,
  validateAddress,
  type KuboNode,
} from "./kubo.js";

export interface Member {
  publicKey: string;
  encryptionKey: string;
  peerId: string;
  profileId: string;
  requestId: string;
  approval: Envelope | null;
}
export interface Organization {
  v: 1;
  scopeId: string;
  owner: string;
  name: string;
  description: string;
  headId: string;
  epoch: number;
  bootstrap: string[];
  members: Member[];
}
export interface Profile {
  name: string;
  addresses: string[];
  updatedAt: string;
}
export interface Snapshot {
  v: 2;
  names: Record<string, CID>;
}
export interface MembershipRequest {
  v: 1;
  id: string;
  requestedAt: string;
  configUrl: string;
  scopeId: string;
  owner: string;
  name: string;
  member: string;
  encryptionKey: string;
  peerId: string;
  peerPublicKey: string;
  peerSignature: string;
  signature: string;
}
export interface SwarmContext {
  store: IpfsStore;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  fetch?: typeof fetch;
  pointerService?: string;
  pointerApiKey?: string;
  state?: State;
  cacheTtl?: number;
  forceRefresh?: boolean;
  diagnostic?: (text: string) => void;
  node?: KuboNode;
  identity?: Identity;
}
async function contextIdentity(
  context: SwarmContext,
  initialize = false,
): Promise<Identity> {
  context.identity ??= await accountIdentity(context.env, initialize);
  return context.identity;
}
interface LocalMembership {
  configUrl: string;
  owner: string;
  account: string;
  encryption: EncryptionIdentity;
  request?: MembershipRequest;
  config?: Organization;
  secret?: MembershipSecret;
}
const cidField = { type: "string", minLength: 1, maxLength: 128 } as const;
export const artifactType: BundleType = {
  contentType: "application/json",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["value", "timestamp"],
    properties: {
      value: cidField,
      previous: cidField,
      timestamp: { type: "string", format: "date-time" },
    },
  },
};
export interface Artifact {
  value: string;
  previous?: string;
  timestamp: string;
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
export function canonicalSwarmUrl(value: string): string {
  if (!/^https?:\/\//.test(value))
    throw new HostError(
      "Swarm requires a configuration URL; old Swarm CID protocol is unsupported.",
    );
  const url = new URL(value);
  canonicalService(url.origin);
  if (
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.toString() !== value ||
    !/^\/v1\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
  )
    throw new HostError(
      "Swarm must be an exact Scope configuration URL; old Swarm CID protocol is unsupported.",
    );
  return value;
}
function coordinates(configUrl: string): {
  service: string;
  scopeId: string;
  configId: string;
} {
  const url = new URL(canonicalSwarmUrl(configUrl));
  const [, , scopeId, configId] = url.pathname.split("/");
  return { service: url.origin, scopeId: scopeId!, configId: configId! };
}
const localName = (url: string) =>
  `${createHash("sha256").update(url).digest("hex")}.json`;
const nodeScope = (service: string, scopeId: string) =>
  createHash("sha256").update(`${service}/v1/${scopeId}`).digest("hex");
async function directory(context: SwarmContext): Promise<string> {
  return privateDirectory(context.stateDir, "swarm-credentials");
}
async function local(
  context: SwarmContext,
  configUrl: string,
): Promise<LocalMembership> {
  const value = await readPrivate<LocalMembership>(
    await directory(context),
    localName(configUrl),
  );
  const identity = await contextIdentity(context);
  if (
    !value ||
    value.configUrl !== configUrl ||
    value.account !== identity.publicKey
  )
    throw new HostError(
      "No local Request for this configuration and HOME identity. Run swarm request with a trusted Owner fingerprint.",
    );
  return value;
}
async function saveLocal(
  context: SwarmContext,
  membership: LocalMembership,
): Promise<void> {
  await writePrivate(
    await directory(context),
    localName(membership.configUrl),
    membership,
  );
}
function client(
  context: SwarmContext,
  service: string,
  identity?: Identity,
  secret?: MembershipSecret,
): ScopeClient {
  return new ScopeClient({
    service,
    ...(identity
      ? {
          signer: {
            ...identity,
            ...(secret ? { certificate: secret.certificate } : {}),
          },
        }
      : {}),
    ...(context.fetch ? { fetch: context.fetch } : {}),
    ...(context.pointerApiKey ? { apiKey: context.pointerApiKey } : {}),
  });
}
function parseOrganization(value: unknown, configUrl: string): Organization {
  const data = object(value, "organization configuration");
  const { scopeId } = coordinates(configUrl);
  if (
    Object.keys(data).sort().join() !==
      "bootstrap,description,epoch,headId,members,name,owner,scopeId,v" ||
    data.v !== 1 ||
    data.scopeId !== scopeId ||
    !isCanonicalPublicKey(data.owner) ||
    typeof data.name !== "string" ||
    data.name.length > 256 ||
    typeof data.description !== "string" ||
    data.description.length > 2048 ||
    typeof data.headId !== "string" ||
    !POINTER_ID_PATTERN.test(data.headId) ||
    typeof data.epoch !== "number" ||
    !Number.isSafeInteger(data.epoch) ||
    data.epoch < 1 ||
    !Array.isArray(data.bootstrap) ||
    data.bootstrap.length > 64 ||
    !Array.isArray(data.members) ||
    data.members.length < 1 ||
    data.members.length > 16
  )
    throw new HostError("Invalid Scope organization configuration.");
  const identities = new Set<string>(),
    peers = new Set<string>(),
    profiles = new Set<string>();
  const members: Member[] = [];
  for (const raw of data.members) {
    const member = object(raw, "member");
    if (
      Object.keys(member).sort().join() !==
        "approval,encryptionKey,peerId,profileId,publicKey,requestId" ||
      !isCanonicalPublicKey(member.publicKey) ||
      typeof member.encryptionKey !== "string" ||
      member.encryptionKey.length > 256 ||
      typeof member.peerId !== "string" ||
      typeof member.profileId !== "string" ||
      !POINTER_ID_PATTERN.test(member.profileId) ||
      typeof member.requestId !== "string" ||
      !POINTER_ID_PATTERN.test(member.requestId) ||
      identities.has(member.publicKey) ||
      peers.has(member.peerId) ||
      profiles.has(member.profileId)
    )
      throw new HostError(
        "Invalid or duplicate member/PeerID/profile binding.",
      );
    identities.add(member.publicKey);
    peers.add(member.peerId);
    profiles.add(member.profileId);
    members.push({
      publicKey: member.publicKey,
      encryptionKey: member.encryptionKey,
      peerId: member.peerId,
      profileId: member.profileId,
      requestId: member.requestId,
      approval:
        member.approval === null ? null : parseEnvelope(member.approval),
    });
  }
  if (!identities.has(data.owner))
    throw new HostError("Owner must remain an organization member.");
  const bootstrap: string[] = [];
  for (const address of data.bootstrap) {
    if (typeof address !== "string")
      throw new HostError("Invalid bootstrap address.");
    validateAddress(address);
    if (![...peers].some((peer) => address.endsWith(`/p2p/${peer}`)))
      throw new HostError("Bootstrap address is not a member PeerID.");
    bootstrap.push(address);
  }
  return {
    v: 1,
    scopeId,
    owner: data.owner,
    name: data.name,
    description: data.description,
    headId: data.headId,
    epoch: data.epoch,
    bootstrap,
    members,
  };
}
function parseProfile(value: unknown, expectedPeer: string): Profile {
  const data = object(value, "member profile");
  if (
    Object.keys(data).sort().join() !== "addresses,name,updatedAt" ||
    typeof data.name !== "string" ||
    data.name.length > 256 ||
    typeof data.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(data.updatedAt)) ||
    !Array.isArray(data.addresses) ||
    data.addresses.length > 16
  )
    throw new HostError("Invalid public member profile.");
  const addresses: string[] = [];
  for (const address of data.addresses) {
    if (typeof address !== "string")
      throw new HostError("Invalid member address.");
    validateAddress(address, expectedPeer);
    addresses.push(address);
  }
  return { name: data.name, addresses, updatedAt: data.updatedAt };
}
async function fetchConfig(
  context: SwarmContext,
  configUrl: string,
): Promise<{ config: Organization; variable: Variable }> {
  const c = coordinates(configUrl),
    api = client(context, c.service);
  const [variable, scope] = await Promise.all([
    api.read(c.scopeId, c.configId),
    api.send<{ owner: string }>("GET", c.scopeId),
  ]);
  const config = parseOrganization(variable.value, configUrl);
  if (scope.owner !== config.owner)
    throw new HostError(
      "Organization Owner does not match the immutable Scope trust root.",
    );
  return { config, variable };
}
function binding(
  configUrl: string,
  config: Organization,
  member: Member,
): EnvelopeBinding {
  return {
    configUrl,
    scopeId: config.scopeId,
    owner: config.owner,
    member: member.publicKey,
    requestId: member.requestId,
    peerId: member.peerId,
    profileId: member.profileId,
    headId: config.headId,
    epoch: config.epoch,
    encryptionKey: member.encryptionKey,
  };
}
async function validateMembershipSecret(
  record: LocalMembership,
  config: Organization,
  member: Member,
): Promise<void> {
  const secret = record.secret;
  if (
    !secret ||
    typeof secret.swarmKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(secret.swarmKey)
  )
    throw new HostError(
      "Invalid approved Swarm key; preserve the original Request.",
    );
  if (record.account !== config.owner) {
    const c = coordinates(record.configUrl);
    await verifyScopeCertificate(
      secret.certificate,
      config.owner,
      c.service,
      c.scopeId,
      config.headId,
      record.account,
    );
    await verifyScopeCertificate(
      secret.certificate,
      config.owner,
      c.service,
      c.scopeId,
      member.profileId,
      record.account,
    );
    if (secret.certificate.body.write.length !== 2)
      throw new HostError(
        "Membership package must grant exactly HEAD and this member's profile.",
      );
  }
}
async function activate(
  context: SwarmContext,
  record: LocalMembership,
): Promise<void> {
  const config = record.config!,
    secret = record.secret!;
  const identity = await contextIdentity(context);
  const self = config.members.find(
    (member) => member.publicKey === identity.publicKey,
  );
  if (!self)
    throw new HostError(
      "This identity was removed. Make a new Request only after Owner confirmation.",
    );
  const c = coordinates(record.configUrl);
  if (identity.publicKey !== config.owner) {
    await verifyScopeCertificate(
      secret.certificate,
      config.owner,
      c.service,
      c.scopeId,
      config.headId,
      identity.publicKey,
    );
    await verifyScopeCertificate(
      secret.certificate,
      config.owner,
      c.service,
      c.scopeId,
      self.profileId,
      identity.publicKey,
    );
  }
  const addresses = [...config.bootstrap];
  const api = client(context, c.service);
  let selfProfile: { profile: Profile; cid: string } | undefined;
  for (const member of config.members) {
    const profile = await api.read(c.scopeId, member.profileId);
    const value = parseProfile(profile.value, member.peerId);
    if (member.publicKey === identity.publicKey)
      selfProfile = { profile: value, cid: profile.cid };
    addresses.push(...value.addresses);
  }
  const node = await startNode(
    context.stateDir,
    nodeScope(c.service, config.scopeId),
    secret.swarmKey,
    config.epoch,
    [...new Set(addresses)],
    context.diagnostic,
  );
  if (node.peerId !== self.peerId)
    throw new HostError(
      "Approved PeerID differs from this local Request's Kubo identity.",
    );
  if (context.node?.api !== node.api) {
    const store = context.store.withLocalSource(kuboSource(node));
    await context.store.close();
    context.store = store;
  }
  context.node = node;
  if (selfProfile && selfProfile.profile.addresses.length === 0) {
    const writer = client(
      context,
      c.service,
      identity,
      identity.publicKey === config.owner ? undefined : secret,
    );
    const profile = {
      ...selfProfile.profile,
      addresses: node.addresses,
      updatedAt: new Date().toISOString(),
    };
    await writer.write(
      c.scopeId,
      self.profileId,
      profile,
      selfProfile.cid,
      uniqueId(),
    );
  }
}
async function refresh(
  context: SwarmContext,
  configUrl: string,
): Promise<LocalMembership> {
  const record = await local(context, configUrl);
  if (record.account === record.owner) {
    const transition = await readPrivate<Removal>(
      await directory(context),
      `transition-${localName(configUrl)}`,
    );
    if (transition && !transition.completed)
      throw new HostError(
        "Organization switch incomplete; only Owner can continue with swarm resume.",
      );
  }
  const { config } = await fetchConfig(context, configUrl);
  if (config.owner !== record.owner)
    throw new HostError("Pinned Owner changed; refusing configuration.");
  if (record.config && config.epoch < record.config.epoch)
    throw new HostError("Organization epoch rollback.");
  const member = config.members.find(
    (member) => member.publicKey === record.account,
  );
  if (!member)
    throw new HostError(
      "No approved package yet, or membership removed; ask the Owner.",
    );
  if (record.account !== config.owner) {
    if (
      !record.request ||
      member.requestId !== record.request.id ||
      member.peerId !== record.request.peerId ||
      !member.approval
    )
      throw new HostError(
        "Published package does not match the locally saved Request.",
      );
    record.secret = await openApproval(
      member.approval,
      binding(configUrl, config, member),
      record.encryption,
    );
  }
  if (!record.secret)
    throw new HostError(
      "Owner key/Swarm key lost: no system recovery is available.",
    );
  record.config = config;
  await validateMembershipSecret(record, config, member);
  await saveLocal(context, record);
  await activate(context, record);
  return record;
}
async function readyMembership(
  context: SwarmContext,
  configUrl: string,
): Promise<LocalMembership> {
  const record = await local(context, configUrl);
  if (record.account === record.owner) {
    const transition = await readPrivate<Removal>(
      await directory(context),
      `transition-${localName(configUrl)}`,
    );
    if (transition && !transition.completed)
      throw new HostError(
        "Organization switch incomplete; run swarm resume before normal Owner operations.",
      );
  }
  if (!record.config || !record.secret) return refresh(context, configUrl);
  if (
    !context.node ||
    context.node.peerId !==
      record.config.members.find((m) => m.publicKey === record.account)?.peerId
  ) {
    try {
      await activate(context, record);
    } catch (cause) {
      if (
        cause instanceof ScopeApiError &&
        [403, 404, 410].includes(cause.status)
      )
        return refresh(context, configUrl);
      throw cause;
    }
  }
  return record;
}
interface BoundHead {
  read(): Promise<Variable & { root: string; etag: string }>;
  write(root: string, cid: string, key: string): Promise<Variable>;
}
function headValue(head: Variable): Variable & { root: string; etag: string } {
  const value = object(head.value, "HEAD");
  if (Object.keys(value).join() !== "root" || typeof value.root !== "string")
    throw new HostError("Invalid HEAD value.");
  return {
    ...head,
    root: value.root,
    etag: `"${head.cid}"`,
  };
}
export async function pointer(
  context: SwarmContext,
  configUrl: string,
): Promise<BoundHead> {
  let record = await readyMembership(context, configUrl);
  const identity = await contextIdentity(context),
    c = coordinates(configUrl);
  const operation = async (
    write: boolean,
    root?: string,
    cid?: string,
    key?: string,
  ) => {
    for (let attempt = 0; ; attempt++) {
      const config = record.config!,
        api = client(
          context,
          c.service,
          identity,
          identity.publicKey === config.owner ? undefined : record.secret,
        );
      try {
        return write
          ? await api.write(
              c.scopeId,
              config.headId,
              { root: root! },
              cid!,
              key!,
            )
          : await api.read(c.scopeId, config.headId);
      } catch (cause) {
        if (
          attempt === 0 &&
          (!write ||
            (cause instanceof ScopeApiError &&
              [401, 403, 404, 410, 423].includes(cause.status)))
        ) {
          const oldHead = record.config!.headId;
          record = await refresh(context, configUrl);
          if (write && record.config!.headId !== oldHead)
            throw new ScopeApiError(
              412,
              "cas_conflict",
              "HEAD switched; recompute against the new final snapshot",
              cause,
            );
          continue;
        }
        throw cause;
      }
    }
  };
  return {
    read: async () => headValue(await operation(false)),
    write: (root, cid, key) => operation(true, root, cid, key),
  };
}
export async function typedJson(
  store: IpfsStore,
  cid: string,
  type: BundleType,
): Promise<unknown> {
  const { bundle, value } = await bundleJson(store, cid);
  if (bundle.schemaKey !== (await encodeSchema(type)).cid.toString())
    throw new HostError("Expected exact Bundle type CID.");
  return value;
}
function parseArtifact(value: unknown): Artifact {
  const data = object(value, "Artifact");
  if (
    Object.keys(data).some(
      (key) => !["value", "previous", "timestamp"].includes(key),
    ) ||
    typeof data.value !== "string" ||
    typeof data.timestamp !== "string" ||
    !Number.isFinite(Date.parse(data.timestamp)) ||
    (data.previous !== undefined && typeof data.previous !== "string")
  )
    throw new HostError("Invalid Artifact.");
  CID.parse(data.value);
  if (data.previous !== undefined) CID.parse(data.previous);
  return {
    value: data.value,
    timestamp: data.timestamp,
    ...(data.previous !== undefined ? { previous: data.previous } : {}),
  };
}
export async function jsonBundle(
  store: IpfsStore,
  type: BundleType,
  value: unknown,
): Promise<string> {
  const encoded = await encodeBundleCar(
    memoryTree(
      new Map([
        [
          ".bundle.yaml",
          new TextEncoder().encode(
            stringify({
              title: "IPAB Data",
              entry: "entry.json",
              type: ".bundle-type.yaml",
            }),
          ),
        ],
        [".bundle-type.yaml", new TextEncoder().encode(stringify(type))],
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
export async function writeSnapshot(
  store: IpfsStore,
  snapshot: Snapshot,
): Promise<string> {
  const encoded = dagCbor.encode(snapshot),
    cid = CID.createV1(dagCbor.code, await sha256.digest(encoded));
  await store.put(cid, encoded);
  return cid.toString();
}
function decodeSnapshot(data: Uint8Array): Snapshot {
  const value = object(dagCbor.decode(data), "State"),
    names = object(value.names, "Names");
  if (value.v !== 2 || Object.keys(value).sort().join() !== "names,v")
    throw new HostError("Unsupported old State; rebuild the Swarm.");
  const links: [string, CID][] = [];
  for (const [name, link] of Object.entries(names)) {
    formalName(name);
    const cid = CID.asCID(link);
    if (!cid) throw new HostError("Names must link CIDs.");
    links.push([name, cid]);
  }
  return { v: 2, names: Object.fromEntries(links) };
}
export async function readSnapshot(
  store: IpfsStore,
  root: string,
): Promise<Snapshot> {
  const publication = await readPublication(store, root);
  return decodeSnapshot(await store.block.get(publication.state.toString()));
}
async function readPublication(
  store: IpfsStore,
  root: string,
): Promise<{ state: CID; previous?: CID }> {
  if (CID.parse(root).code !== dagCbor.code)
    throw new HostError("Publication must be DAG-CBOR.");
  const publication = object(
    dagCbor.decode(await store.block.get(root)),
    "publication",
  );
  const state = CID.asCID(publication.state);
  const previous =
    publication.previous === undefined
      ? undefined
      : CID.asCID(publication.previous);
  if (
    publication.v !== 1 ||
    !state ||
    Object.keys(publication).some(
      (k) => !["v", "state", "previous"].includes(k),
    ) ||
    (publication.previous !== undefined && !previous)
  )
    throw new HostError("Invalid publication record.");
  return { state, ...(previous ? { previous } : {}) };
}
async function publication(
  store: IpfsStore,
  state: string,
  previous?: string,
): Promise<string> {
  const data = dagCbor.encode({
    v: 1,
    state: CID.parse(state),
    ...(previous ? { previous: CID.parse(previous) } : {}),
  });
  const cid = CID.createV1(dagCbor.code, await sha256.digest(data));
  await store.put(cid, data);
  return cid.toString();
}
export interface SwarmHeader {
  head: Variable & { root: string; etag: string };
  snapshot: Snapshot;
  config: Organization;
  source: "cache" | "network";
  verifiedAt: string;
}
export async function swarmHeader(
  context: SwarmContext,
  configUrl: string,
  force = context.forceRefresh ?? false,
): Promise<SwarmHeader> {
  canonicalSwarmUrl(configUrl);
  let record = force
    ? await refresh(context, configUrl)
    : await readyMembership(context, configUrl);
  const ttl = context.cacheTtl ?? 300;
  const cached = force
    ? undefined
    : (withState(context, (state) =>
        state.swarmHeader(record.account, configUrl),
      ) as
        | {
            head: Variable;
            snapshot: string;
            verifiedAt: number;
            headId: string;
          }
        | undefined);
  if (
    cached &&
    cached.headId === record.config!.headId &&
    Date.now() >= cached.verifiedAt &&
    Date.now() - cached.verifiedAt < ttl * 1000
  )
    return {
      head: headValue(cached.head),
      snapshot: decodeSnapshot(Buffer.from(cached.snapshot, "base64")),
      config: record.config!,
      source: "cache",
      verifiedAt: new Date(cached.verifiedAt).toISOString(),
    };
  let head = await (await pointer(context, configUrl)).read();
  let snapshot: Snapshot;
  try {
    snapshot = await readSnapshot(context.store, head.root);
  } catch {
    record = await refresh(context, configUrl);
    head = await (await pointer(context, configUrl)).read();
    snapshot = await readSnapshot(context.store, head.root);
  }
  const current = await local(context, configUrl),
    verifiedAt = Date.now();
  withState(context, (state) => {
    state.saveSwarmHeader(record.account, configUrl, {
      head,
      snapshot: Buffer.from(dagCbor.encode(snapshot)).toString("base64"),
      verifiedAt,
      headId: current.config!.headId,
    });
  });
  return {
    head,
    snapshot,
    config: current.config!,
    source: "network",
    verifiedAt: new Date(verifiedAt).toISOString(),
  };
}
export async function addSwarm(
  context: SwarmContext,
  url: string,
  alias?: string,
): Promise<void> {
  canonicalSwarmUrl(url);
  await readyMembership(context, url);
  withState(context, (state) => state.registerSwarm(url, alias));
}
interface Creation {
  owner: string;
  service: string;
  encryption: EncryptionIdentity;
  key: string;
  name: string;
  description: string;
  createdAt: string;
  scopeId?: string;
  headId?: string;
  profileId?: string;
  configId?: string;
  config?: Organization;
}
export async function createSwarm(
  context: SwarmContext,
  options: {
    service?: string;
    resume?: string;
    properties?: { name: string; description: string };
    alias?: string;
    addresses?: string[];
  } = {},
): Promise<string> {
  if (
    (options.properties?.name.length ?? 0) > 256 ||
    (options.properties?.description.length ?? 0) > 2048 ||
    (options.addresses?.length ?? 0) > 16
  )
    throw new HostError(
      "Organization name/description or address limit exceeded.",
    );
  const service = canonicalService(context.pointerService ?? "");
  if (
    !context.pointerApiKey ||
    (options.service && options.service !== service)
  )
    throw new HostError(
      "Configure origin-bound pointers.service/apiKey before creating a Scope.",
    );
  const identity = await contextIdentity(context, true),
    op = options.resume ?? uniqueId(),
    dir = await directory(context);
  if (!POINTER_ID_PATTERN.test(op))
    throw new HostError("Invalid creation resume ID.");
  return withPrivateLock(dir, async () => {
    let record = await readPrivate<Creation>(dir, `creation-${op}.json`);
    if (options.alias !== undefined) {
      const existingUrl =
        record?.scopeId && record.configId
          ? `${service}/v1/${record.scopeId}/${record.configId}`
          : undefined;
      withState(context, (state) => {
        state.checkSwarmAlias(options.alias!, existingUrl);
      });
    }
    if (!record) {
      if (options.resume) throw new HostError("Unknown creation operation.");
      record = {
        owner: identity.publicKey,
        service,
        encryption: encryptionIdentity(),
        key: randomBytes(32).toString("hex"),
        name: options.properties?.name ?? "",
        description: options.properties?.description ?? "",
        createdAt: new Date().toISOString(),
      };
      await writePrivate(dir, `creation-${op}.json`, record);
    }
    if (record.owner !== identity.publicKey || record.service !== service)
      throw new HostError("Creation belongs to another Owner or service.");
    const save = () => writePrivate(dir, `creation-${op}.json`, record);
    const api = client(context, service, identity);
    try {
      if (!record.scopeId) {
        record.scopeId = (await api.createScope(`${op}.scope`)).id;
        await save();
      }
      const node = await prepareNode(
        context.stateDir,
        nodeScope(service, record.scopeId),
      );
      if (!record.headId) {
        const root = await publication(
          context.store,
          await writeSnapshot(context.store, { v: 2, names: {} }),
        );
        record.headId = (
          await api.create(record.scopeId, { root }, `${op}.head`)
        ).id;
        await save();
      }
      if (!record.profileId) {
        const addresses = options.addresses ?? node.addresses;
        for (const address of addresses) validateAddress(address, node.peerId);
        record.profileId = (
          await api.create(
            record.scopeId,
            { name: record.name, addresses, updatedAt: record.createdAt },
            `${op}.profile`,
          )
        ).id;
        await save();
      }
      if (!record.config) {
        record.config = {
          v: 1,
          scopeId: record.scopeId,
          owner: identity.publicKey,
          name: record.name,
          description: record.description,
          headId: record.headId,
          epoch: 1,
          bootstrap: options.addresses ?? node.addresses,
          members: [
            {
              publicKey: identity.publicKey,
              encryptionKey: record.encryption.publicKey,
              peerId: node.peerId,
              profileId: record.profileId,
              requestId: op,
              approval: null,
            },
          ],
        };
        await save();
      }
      if (!record.configId) {
        record.configId = (
          await api.create(record.scopeId, record.config, `${op}.config`)
        ).id;
        await save();
      }
      const configUrl = `${service}/v1/${record.scopeId}/${record.configId}`;
      const cert = await issueScopeCertificate(
        {
          v: 1,
          service,
          scopeId: record.scopeId,
          subject: identity.publicKey,
          write: [record.headId, record.profileId],
        },
        await importPrivateKeyPkcs8(identity.privateKey),
      );
      const membership: LocalMembership = {
        configUrl,
        owner: identity.publicKey,
        account: identity.publicKey,
        encryption: record.encryption,
        config: record.config,
        secret: { certificate: cert, swarmKey: record.key },
      };
      await saveLocal(context, membership);
      await activate(context, membership);
      const head = await api.read(record.scopeId, record.headId);
      await provideContent(
        context.store,
        [headValue(head).root],
        context.node!.api,
        context.fetch,
        context.node!.auth,
      );
      withState(context, (state) =>
        state.registerSwarm(configUrl, options.alias),
      );
      return configUrl;
    } catch (cause) {
      throw new HostError(
        `Swarm creation incomplete: ${message(cause)}. Resume only with swarm create --resume ${op}.`,
      );
    }
  });
}
const requestMessage = (
  request: Omit<MembershipRequest, "signature" | "peerSignature">,
) => JSON.stringify(["IPAB-REQUEST/1", request]);
export async function exportRequest(
  context: SwarmContext,
  url: string,
  output: string,
): Promise<string> {
  const record = await local(context, canonicalSwarmUrl(url));
  if (!record.request) throw new HostError("Owner membership has no Request.");
  const handle = await open(output, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record.request, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return record.request.id;
}
export async function requestMembership(
  context: SwarmContext,
  url: string,
  options: {
    ownerFingerprint: string;
    name?: string;
    alias?: string;
    output?: string;
  },
): Promise<string> {
  if ((options.name?.length ?? 0) > 256)
    throw new HostError("Request name exceeds 256 characters.");
  canonicalSwarmUrl(url);
  const identity = await contextIdentity(context, true);
  const { config } = await fetchConfig(context, url);
  if (options.ownerFingerprint !== (await keyId(config.owner)))
    throw new HostError(
      `Trusted Owner fingerprint required; observed ${await keyId(config.owner)}. Verify through an independent trusted channel.`,
    );
  const dir = await directory(context);
  await withPrivateLock(dir, async () => {
    if (options.alias !== undefined)
      withState(context, (state) => {
        state.checkSwarmAlias(options.alias!, url);
      });
    const existing = await readPrivate<LocalMembership>(dir, localName(url));
    if (existing) {
      if (
        existing.account !== identity.publicKey ||
        existing.owner !== config.owner
      )
        throw new HostError(
          "Existing Request belongs to a different identity or pinned Owner.",
        );
      if (!existing.request)
        throw new HostError("This identity is already the Owner.");
      withState(context, (state) => state.registerSwarm(url, options.alias));
      return;
    }
    const node = await prepareNode(
        context.stateDir,
        nodeScope(coordinates(url).service, config.scopeId),
      ),
      encryption = encryptionIdentity();
    const body = {
      v: 1 as const,
      id: uniqueId(),
      requestedAt: new Date().toISOString(),
      configUrl: url,
      scopeId: config.scopeId,
      owner: config.owner,
      name: options.name ?? "",
      member: identity.publicKey,
      encryptionKey: encryption.publicKey,
      peerId: node.peerId,
      peerPublicKey: "",
    };
    body.peerPublicKey = (await peerProof(node, "identity")).publicKey;
    const proof = await peerProof(node, requestMessage(body));
    const peerSignature = proof.signature;
    const request = {
      ...body,
      peerSignature,
      signature: await signEd25519(
        await importPrivateKeyPkcs8(identity.privateKey),
        JSON.stringify(["IPAB-REQUEST-MEMBER/1", body, peerSignature]),
      ),
    };
    await saveLocal(context, {
      configUrl: url,
      owner: config.owner,
      account: identity.publicKey,
      encryption,
      request,
    });
    withState(context, (state) => state.registerSwarm(url, options.alias));
  });
  if (options.output) await exportRequest(context, url, options.output);
  return (await local(context, url)).request!.id;
}
export async function verifiedRequest(
  path: string,
): Promise<MembershipRequest> {
  if ((await lstat(path)).size > 16 * 1024)
    throw new HostError("Request file exceeds 16 KiB.");
  return verifyRequest(JSON.parse(await readFile(path, "utf8")) as unknown);
}
async function verifyRequest(input: unknown): Promise<MembershipRequest> {
  const fields = object(input, "Request");
  if (
    Object.keys(fields).sort().join() !==
      "configUrl,encryptionKey,id,member,name,owner,peerId,peerPublicKey,peerSignature,requestedAt,scopeId,signature,v" ||
    fields.v !== 1
  )
    throw new HostError("Invalid self-contained Request format.");
  const {
    id,
    member,
    owner,
    name,
    encryptionKey,
    requestedAt,
    configUrl,
    scopeId,
    peerId: requestPeer,
    peerPublicKey,
    peerSignature,
    signature,
  } = fields;
  if (
    typeof id !== "string" ||
    !POINTER_ID_PATTERN.test(id) ||
    !isCanonicalPublicKey(member) ||
    !isCanonicalPublicKey(owner) ||
    typeof name !== "string" ||
    name.length > 256 ||
    typeof encryptionKey !== "string" ||
    encryptionKey.length > 256 ||
    typeof requestedAt !== "string" ||
    !Number.isFinite(Date.parse(requestedAt)) ||
    typeof configUrl !== "string" ||
    typeof scopeId !== "string" ||
    coordinates(configUrl).scopeId !== scopeId ||
    !isCanonicalPublicKey(peerPublicKey) ||
    typeof requestPeer !== "string" ||
    peerId(peerPublicKey) !== requestPeer ||
    typeof peerSignature !== "string" ||
    typeof signature !== "string"
  )
    throw new HostError("Invalid self-contained Request.");
  const body: Omit<MembershipRequest, "signature" | "peerSignature"> = {
    v: 1,
    id,
    requestedAt,
    configUrl,
    scopeId,
    owner,
    name,
    member,
    encryptionKey,
    peerId: requestPeer,
    peerPublicKey,
  };
  if (
    !(await verifyEd25519(
      await importPublicKeyRaw(peerPublicKey),
      peerSignature,
      requestMessage(body),
    )) ||
    !(await verifyEd25519(
      await importPublicKeyRaw(member),
      signature,
      JSON.stringify(["IPAB-REQUEST-MEMBER/1", body, peerSignature]),
    ))
  )
    throw new HostError(
      "Request member or PeerID possession proof is invalid.",
    );
  return { ...body, peerSignature, signature };
}
export async function membershipRequestSummary(
  request: MembershipRequest,
): Promise<string> {
  return [
    `Request: ${request.id}`,
    `Target: ${request.configUrl}`,
    `Name: ${JSON.stringify(request.name)}`,
    `Member public key: ${request.member}`,
    `Member fingerprint: ${await keyId(request.member)}`,
    `PeerID: ${request.peerId}`,
    `Requested at: ${JSON.stringify(request.requestedAt)}`,
    "Verify the applicant through an independent trusted channel before approving.",
  ].join("\n");
}
interface ApprovalOperation {
  owner: string;
  request: MembershipRequest;
  operation: string;
  createdAt: string;
  profileId?: string;
  completed?: boolean;
  value?: Organization;
  baseline?: string;
}
async function ownerCheck(
  context: SwarmContext,
  url: string,
): Promise<{ identity: Identity; record: LocalMembership }> {
  const identity = await contextIdentity(context),
    record = await readyMembership(context, url);
  if (identity.publicKey !== record.owner)
    throw new HostError(
      "Only the pinned Owner can manage membership or organization configuration.",
    );
  const transition = await readPrivate<Removal>(
    await directory(context),
    `transition-${localName(url)}`,
  );
  if (transition && !transition.completed)
    throw new HostError(
      "Organization switch incomplete: run swarm resume for this URL before other Owner changes.",
    );
  return { identity, record };
}
export async function approveMembership(
  context: SwarmContext,
  input: string | MembershipRequest,
  options: { again?: boolean } = {},
): Promise<string> {
  const request =
      typeof input === "string"
        ? await verifiedRequest(input)
        : await verifyRequest(input),
    url = request.configUrl;
  const dir = await directory(context);
  return withPrivateLock(dir, async () => {
    const { identity, record } = await ownerCheck(context, url);
    if (request.owner !== identity.publicKey)
      throw new HostError("Request targets a different Owner.");
    let operation = await readPrivate<ApprovalOperation>(
      dir,
      `approval-${request.id}.json`,
    );
    if (operation && !operation.completed && options.again)
      throw new HostError(
        "The prior approval is unconfirmed; resume the same Request without --again before starting a new explicit approval.",
      );
    if (operation?.completed && !options.again) {
      if (
        operation.owner !== identity.publicKey ||
        JSON.stringify(operation.request) !== JSON.stringify(request)
      )
        throw new HostError(
          "This Request ID differs from advisory history; manually verify it and use --again for a new explicit approval.",
        );
      context.diagnostic?.(
        `Previously approved Request ${request.id} from ${request.requestedAt}. History is advisory, not a revocation boundary.`,
      );
      context.diagnostic?.(
        "Reusing the completed approval result without granting new authority. Use --again only after fresh manual confirmation.",
      );
      return url;
    }
    if (!operation || options.again) {
      operation = {
        owner: identity.publicKey,
        request,
        operation: uniqueId(),
        createdAt: new Date().toISOString(),
      };
      await writePrivate(dir, `approval-${request.id}.json`, operation);
    }
    if (
      operation.owner !== identity.publicKey ||
      JSON.stringify(operation.request) !== JSON.stringify(request)
    )
      throw new HostError("Saved approval does not match this exact Request.");
    const save = () =>
      writePrivate(dir, `approval-${request.id}.json`, operation);
    const c = coordinates(url),
      api = client(context, c.service, identity);
    const fetched = await fetchConfig(context, url);
    if (
      fetched.config.epoch !== record.config!.epoch ||
      fetched.config.headId !== record.config!.headId
    )
      throw new HostError(
        "Owner local keys are not synchronized with this organization epoch.",
      );
    if (!operation.profileId) {
      const previousMember = fetched.config.members.find(
        (m) => m.publicKey === request.member,
      );
      if (previousMember && previousMember.peerId !== request.peerId)
        throw new HostError(
          "PeerID rebinding requires removing the old membership first, then explicitly approving this Request.",
        );
      const existingProfile = fetched.config.members.find(
        (m) => m.publicKey === request.member,
      )?.profileId;
      if (existingProfile) operation.profileId = existingProfile;
      if (!operation.profileId)
        operation.profileId = (
          await api.create(
            c.scopeId,
            {
              name: request.name,
              addresses: [],
              updatedAt: operation.createdAt,
            },
            `${operation.operation}.profile`,
          )
        ).id;
      await save();
    }
    if (!operation.value) {
      const member: Member = {
        publicKey: request.member,
        encryptionKey: request.encryptionKey,
        peerId: request.peerId,
        profileId: operation.profileId,
        requestId: request.id,
        approval: null,
      };
      const config = {
        ...fetched.config,
        members: fetched.config.members.filter(
          (m) => m.publicKey !== request.member,
        ),
      };
      if (config.members.some((m) => m.peerId === request.peerId))
        throw new HostError("PeerID is already assigned to another member.");
      if (request.member === identity.publicKey)
        throw new HostError("Owner cannot request member approval.");
      if (config.members.length >= 16)
        throw new HostError("Organization member limit is 16.");
      const certificate = await issueScopeCertificate(
        {
          v: 1,
          service: c.service,
          scopeId: c.scopeId,
          subject: request.member,
          write: [config.headId, member.profileId],
        },
        await importPrivateKeyPkcs8(identity.privateKey),
      );
      member.approval = await sealApproval(
        binding(url, config, member),
        { certificate, swarmKey: record.secret!.swarmKey },
        identity,
      );
      config.members.push(member);
      operation.value = config;
      operation.baseline = fetched.variable.cid;
      await save();
    }
    const observed = await api.read(c.scopeId, c.configId);
    if (observed.cid !== (await valueCid(operation.value)))
      await api.write(
        c.scopeId,
        c.configId,
        operation.value,
        operation.baseline!,
        `${operation.operation}.publish`,
      );
    operation.completed = true;
    await save();
    record.config = operation.value;
    await saveLocal(context, record);
    return url;
  });
}
export async function updateSwarm(
  context: SwarmContext,
  url: string,
  changes: { name?: string; description?: string },
) {
  if (
    (changes.name?.length ?? 0) > 256 ||
    (changes.description?.length ?? 0) > 2048
  )
    throw new HostError("Organization name/description limit exceeded.");
  const { identity, record } = await ownerCheck(context, url),
    c = coordinates(url);
  if (changes.name === undefined && changes.description === undefined)
    throw new HostError("swarm update requires name or description.");
  const fetched = await fetchConfig(context, url),
    config = { ...fetched.config, ...changes };
  const result = await client(context, c.service, identity).write(
    c.scopeId,
    c.configId,
    config,
    fetched.variable.cid,
    uniqueId(),
  );
  record.config = config;
  await saveLocal(context, record);
  return {
    configUrl: url,
    headId: config.headId,
    valueCid: result.cid,
    properties: { name: config.name, description: config.description },
  };
}
export async function updateProfile(
  context: SwarmContext,
  url: string,
  changes: { name?: string; addresses?: string[] },
): Promise<Profile> {
  if (changes.name !== undefined && changes.name.length > 256)
    throw new HostError("Profile name exceeds 256 characters.");
  if ((changes.addresses?.length ?? 0) > 16)
    throw new HostError("Profile address limit is 16.");
  const record = await readyMembership(context, url),
    identity = await contextIdentity(context),
    c = coordinates(url);
  const member = record.config!.members.find(
    (m) => m.publicKey === identity.publicKey,
  )!;
  for (const address of changes.addresses ?? [])
    validateAddress(address, member.peerId);
  const api = client(
    context,
    c.service,
    identity,
    identity.publicKey === record.owner ? undefined : record.secret,
  );
  const existing = await api.read(c.scopeId, member.profileId);
  const profile = {
    ...parseProfile(existing.value, member.peerId),
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  await api.write(
    c.scopeId,
    member.profileId,
    profile,
    existing.cid,
    uniqueId(),
  );
  return profile;
}
interface Removal {
  owner: string;
  url: string;
  operation: string;
  member: string;
  oldConfig: Organization;
  configCid: string;
  newKey: string;
  oldKey: string;
  finalHead?: Variable;
  finalCaptured?: boolean;
  finalClosureRoots?: string[];
  newHeadId?: string;
  nextConfig?: Organization;
  published?: boolean;
  completed?: boolean;
}
export async function removeMember(
  context: SwarmContext,
  url: string,
  member: string,
): Promise<void> {
  const dir = await directory(context);
  await withPrivateLock(dir, async () => {
    const { identity, record: membership } = await ownerCheck(context, url);
    if (member === identity.publicKey)
      throw new HostError("Owner removal/recovery is unsupported.");
    const fetched = await fetchConfig(context, url);
    if (!fetched.config.members.some((m) => m.publicKey === member))
      throw new HostError("Unknown member public key.");
    const record: Removal = {
      owner: identity.publicKey,
      url,
      operation: uniqueId(),
      member,
      oldConfig: fetched.config,
      configCid: fetched.variable.cid,
      oldKey: membership.secret!.swarmKey,
      newKey: randomBytes(32).toString("hex"),
    };
    await writePrivate(dir, `transition-${localName(url)}`, record);
  });
  await resumeRemoval(context, url);
}
export async function resumeRemoval(
  context: SwarmContext,
  url: string,
): Promise<void> {
  const dir = await directory(context);
  return withPrivateLock(dir, async () => {
    const identity = await contextIdentity(context);
    const record = await readPrivate<Removal>(
      dir,
      `transition-${localName(url)}`,
    );
    if (!record || record.owner !== identity.publicKey || record.url !== url)
      throw new HostError("No resumable switch owned by this identity.");
    if (record.completed) return;
    const c = coordinates(url),
      api = client(context, c.service, identity);
    const save = () =>
      writePrivate(dir, `transition-${localName(url)}`, record);
    try {
      if (!record.finalHead) {
        record.finalHead = await api.freeze(
          c.scopeId,
          record.oldConfig.headId,
          `${record.operation}.freeze`,
        );
        await save();
      }
      // Fetch the frozen final DAG while the old private network is still connected.
      // A publication acknowledged immediately before freeze may not be cached on Owner.
      const membershipBeforeSwitch = await local(context, url);
      if (!record.finalCaptured) {
        membershipBeforeSwitch.config = record.oldConfig;
        membershipBeforeSwitch.secret!.swarmKey = record.oldKey;
        await activate(context, membershipBeforeSwitch);
        if (!record.finalClosureRoots) {
          record.finalClosureRoots = await frozenPublicationClosure(
            context.store,
            headValue(record.finalHead).root,
          );
          await save();
        }
        await provideContent(
          context.store,
          record.finalClosureRoots,
          context.node!.api,
          context.fetch,
          context.node!.auth,
        );
        record.finalCaptured = true;
        await save();
      }
      if (
        !record.finalClosureRoots ||
        record.finalClosureRoots[0] !== headValue(record.finalHead).root
      )
        throw new HostError(
          "Frozen publication closure is missing; refusing to retire the old network or HEAD.",
        );
      if (!record.newHeadId) {
        record.newHeadId = (
          await api.create(
            c.scopeId,
            record.finalHead.value,
            `${record.operation}.newhead`,
          )
        ).id;
        await save();
      }
      if (!record.nextConfig) {
        const config = {
          ...record.oldConfig,
          headId: record.newHeadId,
          epoch: record.oldConfig.epoch + 1,
          members: structuredClone(
            record.oldConfig.members.filter(
              (m) => m.publicKey !== record.member,
            ),
          ),
          bootstrap: record.oldConfig.bootstrap.filter(
            (address) =>
              !address.endsWith(
                `/p2p/${record.oldConfig.members.find((m) => m.publicKey === record.member)!.peerId}`,
              ),
          ),
        };
        for (const member of config.members) {
          if (member.publicKey === identity.publicKey) continue;
          const certificate = await issueScopeCertificate(
            {
              v: 1,
              service: c.service,
              scopeId: c.scopeId,
              subject: member.publicKey,
              write: [config.headId, member.profileId],
            },
            await importPrivateKeyPkcs8(identity.privateKey),
          );
          member.approval = await sealApproval(
            binding(url, config, member),
            { certificate, swarmKey: record.newKey },
            identity,
          );
        }
        record.nextConfig = config;
        await save();
      }
      const leaving = record.oldConfig.members.find(
        (m) => m.publicKey === record.member,
      )!;
      // Delete the profile before exposing the new configuration. Old HEAD stays readable until final cleanup.
      try {
        await api.freeze(
          c.scopeId,
          leaving.profileId,
          `${record.operation}.profilefreeze`,
        );
      } catch (cause) {
        if (!(cause instanceof ScopeApiError) || cause.status !== 410)
          throw cause;
      }
      try {
        await api.delete(
          c.scopeId,
          leaving.profileId,
          `${record.operation}.profiledelete`,
        );
      } catch (cause) {
        if (!(cause instanceof ScopeApiError) || cause.status !== 410)
          throw cause;
      }
      if (!record.published) {
        const observed = await api.read(c.scopeId, c.configId);
        if (observed.cid !== (await valueCid(record.nextConfig)))
          await api.write(
            c.scopeId,
            c.configId,
            record.nextConfig,
            record.configCid,
            `${record.operation}.config`,
          );
        record.published = true;
        await save();
      }
      const membership = await local(context, url);
      membership.config = record.nextConfig;
      membership.secret!.swarmKey = record.newKey;
      await saveLocal(context, membership);
      await activate(context, membership);
      await provideContent(
        context.store,
        record.finalClosureRoots,
        context.node!.api,
        context.fetch,
        context.node!.auth,
      );
      try {
        await api.delete(
          c.scopeId,
          record.oldConfig.headId,
          `${record.operation}.delete`,
        );
      } catch (cause) {
        if (!(cause instanceof ScopeApiError) || cause.status !== 410)
          throw cause;
      }
      record.completed = true;
      await save();
      withState(context, (state) => {
        state.invalidateSwarmHeader(url);
      });
    } catch (cause) {
      throw new HostError(
        `Organization switch incomplete (old HEAD is never unfrozen): ${message(cause)}. Owner must run swarm resume ${url}.`,
      );
    }
  });
}
export function formalName(name: string): string {
  relativePath(name);
  if (name.length > 256 || name.startsWith("builtin:"))
    throw new HostError("Invalid formal Name.");
  return name;
}
export function parseNameReference(
  reference: string,
): { swarm?: string; name: string } | undefined {
  if (/^name:/i.test(reference))
    throw new HostError("name: is unsupported; use ipab://ALIAS/PATH.");
  if (!/^ipab:/i.test(reference)) return undefined;
  const match = /^ipab:\/\/([^/]*)\/([^?#\s]*)$/i.exec(reference);
  if (!match)
    throw new HostError(
      "Invalid IPAB URI; percent-encode the configuration URL authority and each path segment.",
    );
  const authority = decodeURIComponent(match[1]!);
  if (authority && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(authority))
    canonicalSwarmUrl(authority);
  const segments = match[2]!.split("/").map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (decoded.includes("/"))
      throw new HostError("Encoded path separators are unsupported.");
    return decoded;
  });
  return {
    ...(authority ? { swarm: authority } : {}),
    name: formalName(segments.join("/")),
  };
}
function referenceFor(url: string, name: string): string {
  const segment = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return `ipab://${segment(url)}/${name.split("/").map(segment).join("/")}`;
}
export async function resolveReference(
  context: SwarmContext,
  reference: string,
  swarm: string | undefined,
  local: (reference: string) => string,
  raw = false,
): Promise<{ targetCid: string; cid: string }> {
  const shared = parseNameReference(reference);
  let targetCid: string;
  if (shared) {
    const selected = shared.swarm
      ? withState(context, (state) => state.resolveSwarm(shared.swarm!))
      : swarm;
    if (!selected)
      throw new HostError(
        "Select a configuration URL/alias using --swarm or swarm use.",
      );
    let header = await swarmHeader(context, selected);
    let link = Object.hasOwn(header.snapshot.names, shared.name)
      ? header.snapshot.names[shared.name]
      : undefined;
    if (!link && header.source === "cache") {
      header = await swarmHeader(context, selected, true);
      link = Object.hasOwn(header.snapshot.names, shared.name)
        ? header.snapshot.names[shared.name]
        : undefined;
    }
    if (!link)
      throw new HostError(
        `Formal Name "${shared.name}" was not found after refreshing HEAD.`,
      );
    targetCid = link.toString();
  } else {
    if (swarm) await readyMembership(context, swarm);
    targetCid = local(reference);
  }
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
    cid = CID.parse(
      parseArtifact(await typedJson(context.store, cid, artifactType)).value,
    )
      .toV1()
      .toString();
  }
  return { targetCid, cid };
}
export async function searchNames(
  context: SwarmContext,
  query: string,
  swarms: readonly { cid: string; alias: string | null }[],
) {
  if (
    !query ||
    query.length > 256 ||
    [...query].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new HostError(
      "Search query must be 1..256 characters without controls.",
    );
  const matches: {
    swarm: string;
    alias: string | null;
    name: string;
    reference: string;
    targetCid: string;
  }[] = [];
  const searched: {
    configUrl: string;
    source: "cache" | "network";
    root: string;
    valueCid: string;
    verifiedAt: string;
  }[] = [];
  for (const swarm of swarms) {
    const header = await swarmHeader(context, swarm.cid);
    searched.push({
      configUrl: swarm.cid,
      source: header.source,
      root: header.head.root,
      valueCid: header.head.cid,
      verifiedAt: header.verifiedAt,
    });
    for (const name of Object.keys(header.snapshot.names).sort())
      if (name.toLowerCase().includes(query.toLowerCase()))
        matches.push({
          swarm: swarm.cid,
          alias: swarm.alias,
          name,
          reference: referenceFor(swarm.cid, name),
          targetCid: header.snapshot.names[name]!.toString(),
        });
  }
  return { matches, swarms: searched };
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
    const node = parseArtifact(await typedJson(store, root, artifactType));
    await dependencies(store, node.value, found);
    if (node.previous) await dependencies(store, node.previous, found);
  } else if (bundle.schemaKey === appSchemaCid.toString()) {
    const app = object(
      JSON.parse(
        new TextDecoder().decode(
          await bytes(await bundle.readFile(bundle.manifest.entry), 64 * 1024),
        ),
      ) as unknown,
      "App",
    );
    if (app.source) {
      const source = object(app.source, "source");
      if (typeof source.cid !== "string")
        throw new HostError("Invalid App source association.");
      await dependencies(store, source.cid, found);
    }
  }
  return found;
}
export async function frozenPublicationClosure(
  store: IpfsStore,
  root: string,
): Promise<string[]> {
  const publications = new Set<string>(),
    content = new Set<string>();
  let current: string | undefined = root;
  while (current !== undefined) {
    if (publications.has(current) || publications.size >= 256)
      throw new HostError(
        "Frozen publication history exceeds limits or contains a cycle.",
      );
    publications.add(current);
    const publication = await readPublication(store, current);
    const snapshot = decodeSnapshot(
      await store.block.get(publication.state.toString()),
    );
    for (const target of Object.values(snapshot.names))
      await dependencies(store, target.toString(), content);
    current = publication.previous?.toString();
  }
  return [
    root,
    ...[...new Set([...publications, ...content])]
      .filter((cid) => cid !== root)
      .sort(),
  ];
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
  if (!options.swarm)
    throw new HostError(
      "Publication requires a selected Swarm configuration URL or alias.",
    );
  const head = await pointer(context, options.swarm);
  const roots = await dependencies(context.store, content);
  if (!options.name) {
    if (options.expect || options.snapshot)
      throw new HostError("--expect/--snapshot require --name.");
    await head.read();
    await provideContent(
      context.store,
      [...roots],
      context.node!.api,
      context.fetch,
      context.node!.auth,
    );
    return content;
  }
  const name = formalName(options.name);
  if (options.snapshot && options.expect)
    throw new HostError("Snapshots cannot replace an occupied Name.");
  const expected = options.expect
    ? CID.parse(options.expect).toV1().toString()
    : undefined;
  if (expected)
    parseArtifact(await typedJson(context.store, expected, artifactType));
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
  for (let attempt = 0; attempt < 8; attempt++) {
    const currentHead = await head.read(),
      current = await readSnapshot(context.store, currentHead.root);
    if (
      (Object.hasOwn(current.names, name)
        ? current.names[name]?.toString()
        : undefined) !== expected
    )
      throw new HostError(
        `Edit conflict for ${name}; candidate ${candidate} remains retained. Choose an explicit baseline.`,
        3,
        "EDIT_CONFLICT",
        "publication",
      );
    const next = await publication(
      context.store,
      await writeSnapshot(context.store, {
        ...current,
        names: { ...current.names, [name]: CID.parse(candidate) },
      }),
      currentHead.root,
    );
    await provideContent(
      context.store,
      [next, ...roots],
      context.node!.api,
      context.fetch,
      context.node!.auth,
    );
    withState(context, (state) => {
      state.invalidateSwarmHeader(options.swarm!);
    });
    try {
      await head.write(next, currentHead.cid, uniqueId());
      return candidate;
    } catch (cause) {
      if (!(cause instanceof ScopeApiError) || cause.status !== 412)
        throw new HostError(
          `HEAD publication unconfirmed: ${message(cause)}. Candidate ${candidate} remains retained; inspect HEAD before retry.`,
          1,
          "HEAD_UNCONFIRMED",
          "publication",
        );
    }
  }
  throw new HostError(`HEAD is busy; candidate ${candidate} remains retained.`);
}
