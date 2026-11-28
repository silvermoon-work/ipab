import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { IpfsStore } from "@ipab/ipfs-store";
import { CarBlockIterator } from "@ipld/car/iterator";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  signEd25519,
} from "@ipab/bundle/pointer/crypto";
import { issueScopeCertificate, uniqueId } from "@ipab/bundle/pointer/scope";
import {
  canonicalSwarmUrl,
  formalName,
  parseNameReference,
  writeSnapshot,
  readSnapshot,
  jsonBundle,
  typedJson,
  artifactType,
  frozenPublicationClosure,
  verifiedRequest,
  membershipRequestSummary,
} from "../src/swarm.js";
import {
  encryptionIdentity,
  sealApproval,
  openApproval,
  type EnvelopeBinding,
} from "../src/swarm-envelope.js";
import { peerId, validateAddress } from "../src/kubo.js";
import { appSchema } from "../src/app-definition.js";
import { contentCar } from "../src/content-provider.js";

describe("onboarding protocol and content", { tags: ["unit"] }, () => {
  it("shows verified approval identity, PeerID and old requestedAt without secrets or terminal injection", async () => {
    const owner = await generateKeyPair(),
      member = await generateKeyPair(),
      node = await generateKeyPair();
    const body = {
      v: 1 as const,
      id: uniqueId(),
      requestedAt: "1995-01-01T00:00:00.000Z",
      configUrl: `https://service.example/v1/${"A".repeat(43)}/${"B".repeat(43)}`,
      scopeId: "A".repeat(43),
      owner: owner.publicRaw,
      name: "Member\nfake prompt",
      member: member.publicRaw,
      encryptionKey: encryptionIdentity().publicKey,
      peerId: peerId(node.publicRaw),
      peerPublicKey: node.publicRaw,
    };
    const peerSignature = await signEd25519(
      node.privateKey,
      JSON.stringify(["IPAB-REQUEST/1", body]),
    );
    const signature = await signEd25519(
      member.privateKey,
      JSON.stringify(["IPAB-REQUEST-MEMBER/1", body, peerSignature]),
    );
    const base = resolve(".test-work");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "request-summary-"));
    const path = join(directory, "request.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ ...body, peerSignature, signature }),
      );
      const summary = await membershipRequestSummary(
        await verifiedRequest(path),
      );
      expect(summary).toContain(member.publicRaw);
      expect(summary).toContain(body.peerId);
      expect(summary).toContain(body.requestedAt);
      expect(summary).toContain('"Member\\nfake prompt"');
      expect(summary).not.toContain(member.privatePkcs8);
      expect(summary).not.toContain(node.privatePkcs8);
      await writeFile(
        path,
        JSON.stringify({ ...body, name: "Tampered", peerSignature, signature }),
      );
      await expect(verifiedRequest(path)).rejects.toThrow("possession proof");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("captures weak Artifact payload/history and App source links from every frozen publication before losing the old source", async () => {
    const sender = IpfsStore.fromClient({
      block: { get: () => Promise.reject(new Error("missing")) },
    });
    const noteType = {
      contentType: "application/json",
      schema: { type: "object" },
    } as const;
    const bytesByCid = new Map<string, Uint8Array>();
    let oldSourceAvailable = true;
    const receiver = IpfsStore.fromClient({
      block: {
        get: (cid) => {
          const block = bytesByCid.get(cid);
          if (!oldSourceAvailable || !block)
            return Promise.reject(new Error("old source unavailable"));
          return Promise.resolve(block);
        },
      },
    });
    const put = async (value: unknown) => {
      const bytes = dagCbor.encode(value),
        cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
      await sender.put(cid, bytes);
      return cid.toString();
    };
    try {
      const source = await jsonBundle(sender, noteType, { source: true });
      const payload = await jsonBundle(sender, appSchema, {
        name: "App",
        version: "1.0.0",
        entry: "resources/app.cjs",
        source: { cid: source },
      });
      const priorPayload = await jsonBundle(sender, noteType, {
        previous: true,
      });
      const historicPayload = await jsonBundle(sender, noteType, {
        historical: true,
      });
      const first = await jsonBundle(sender, artifactType, {
        value: priorPayload,
        timestamp: new Date().toISOString(),
      });
      const latest = await jsonBundle(sender, artifactType, {
        value: payload,
        previous: first,
        timestamp: new Date().toISOString(),
      });
      const historic = await jsonBundle(sender, artifactType, {
        value: historicPayload,
        timestamp: new Date().toISOString(),
      });
      const oldRoot = await put({
        v: 1,
        state: CID.parse(
          await writeSnapshot(sender, {
            v: 2,
            names: { old: CID.parse(historic) },
          }),
        ),
      });
      const root = await put({
        v: 1,
        state: CID.parse(
          await writeSnapshot(sender, {
            v: 2,
            names: { app: CID.parse(latest) },
          }),
        ),
        previous: CID.parse(oldRoot),
      });
      const complete = [
        root,
        latest,
        first,
        historic,
        payload,
        priorPayload,
        historicPayload,
        source,
      ];
      const car = await CarBlockIterator.fromBytes(
        await contentCar(sender, complete),
      );
      for await (const block of car)
        bytesByCid.set(block.cid.toString(), block.bytes);
      const closure = await frozenPublicationClosure(receiver, root);
      expect(closure).toEqual(expect.arrayContaining(complete));
      await contentCar(receiver, closure);
      oldSourceAvailable = false;
      const replay = await CarBlockIterator.fromBytes(
        await contentCar(receiver, closure),
      );
      expect((await replay.getRoots()).map((cid) => cid.toString())).toEqual(
        closure,
      );
      expect(await typedJson(receiver, source, noteType)).toEqual({
        source: true,
      });
      expect(await typedJson(receiver, historicPayload, noteType)).toEqual({
        historical: true,
      });
    } finally {
      await receiver.close();
      await sender.close();
    }
  });
  it("accepts configuration URLs and encoded cross-device references without lowercasing identity", () => {
    const url = `https://service.example/v1/${uniqueId()}/${uniqueId()}`;
    expect(canonicalSwarmUrl(url)).toBe(url);
    expect(
      parseNameReference(
        `ipab://${encodeURIComponent(url)}/Apps/Hello%20World`,
      ),
    ).toEqual({ swarm: url, name: "Apps/Hello World" });
    expect(parseNameReference("ipab://Work/apps/Hello")).toEqual({
      swarm: "Work",
      name: "apps/Hello",
    });
    expect(parseNameReference("ipab:///apps/hello")).toEqual({
      name: "apps/hello",
    });
    expect(
      parseNameReference(
        "bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq",
      ),
    ).toBeUndefined();
    for (const invalid of [
      "name:hello",
      "ipab://work/a%2Fb",
      "ipab://work/../hello",
      "ipab://work/name?query",
    ])
      expect(() => parseNameReference(invalid)).toThrow();
    for (const invalid of [
      url + "?x=1",
      "http://untrusted.example/v1/a/b",
      uniqueId(),
    ])
      expect(() => canonicalSwarmUrl(invalid)).toThrow();
    expect(() => formalName("builtin:hello")).toThrow();
  });
  it("encrypts an exact-ID nonexpiring authorization package bound to all identities and resource IDs", async () => {
    const owner = await generateKeyPair(),
      member = await generateKeyPair(),
      encryption = encryptionIdentity();
    const binding: EnvelopeBinding = {
      configUrl: "https://service.example/v1/scope/config",
      scopeId: uniqueId(),
      owner: owner.publicRaw,
      member: member.publicRaw,
      requestId: uniqueId(),
      peerId: peerId(member.publicRaw),
      profileId: uniqueId(),
      headId: uniqueId(),
      epoch: 1,
      encryptionKey: encryption.publicKey,
    };
    const certificate = await issueScopeCertificate(
      {
        v: 1,
        service: "https://service.example",
        scopeId: binding.scopeId,
        subject: member.publicRaw,
        write: [binding.headId, binding.profileId],
      },
      await importPrivateKeyPkcs8(owner.privatePkcs8),
    );
    const secret = { certificate, swarmKey: "ab".repeat(32) };
    const envelope = await sealApproval(binding, secret, {
      publicKey: owner.publicRaw,
      privateKey: owner.privatePkcs8,
    });
    expect(JSON.stringify(envelope)).not.toContain(secret.swarmKey);
    expect(await openApproval(envelope, binding, encryption)).toEqual(secret);
    for (const changes of [
      { requestId: uniqueId() },
      { epoch: 2 },
      { profileId: uniqueId() },
      { headId: uniqueId() },
      { owner: member.publicRaw },
      { member: owner.publicRaw },
      { peerId: "another" },
      { encryptionKey: encryptionIdentity().publicKey },
      { configUrl: "https://other.example" },
      { scopeId: uniqueId() },
    ])
      await expect(
        openApproval(envelope, { ...binding, ...changes }, encryption),
      ).rejects.toThrow("binding");
    await expect(
      openApproval(
        { ...envelope, ciphertext: envelope.ciphertext.slice(1) },
        binding,
        encryption,
      ),
    ).rejects.toThrow("signature");
    await expect(
      openApproval(envelope, binding, {
        ...encryption,
        privateKey: encryptionIdentity().privateKey,
      }),
    ).rejects.toThrow("decrypt");
  });
  it("requires IPv4 TCP LAN/VPN addresses with the exact approved PeerID", () => {
    const peer = peerId(Buffer.alloc(32, 1).toString("base64url"));
    validateAddress(`/ip4/192.168.1.2/tcp/4001/p2p/${peer}`, peer);
    validateAddress(`/ip4/10.20.0.2/tcp/4001/p2p/${peer}`, peer);
    for (const value of [
      `/ip4/999.1.1.1/tcp/4001/p2p/${peer}`,
      `/ip4/10.0.0.2/tcp/65536/p2p/${peer}`,
      "/dns/host/tcp/4001/p2p/a",
      `/ip4/10.0.0.2/tcp/4001/p2p/another`,
    ])
      expect(() => {
        validateAddress(value, peer);
      }).toThrow();
  });
  it("keeps names as CID links in State and rejects old metadata or malformed publications", async () => {
    const store = IpfsStore.fromClient({
      block: { get: () => Promise.reject(new Error("missing")) },
    });
    const block = async (value: unknown) => {
      const bytes = dagCbor.encode(value),
        cid = CID.createV1(dagCbor.code, await sha256.digest(bytes));
      await store.put(cid, bytes);
      return cid;
    };
    try {
      const target = await block({ content: true });
      const state = await writeSnapshot(store, {
        v: 2,
        names: { "apps/hello": target },
      });
      const root = await block({ v: 1, state: CID.parse(state) });
      expect(
        (await readSnapshot(store, root.toString())).names[
          "apps/hello"
        ]!.toString(),
      ).toBe(target.toString());
      const old = await block({
        v: 1,
        properties: { name: "old", description: "" },
        names: {},
      });
      await expect(
        readSnapshot(store, (await block({ v: 1, state: old })).toString()),
      ).rejects.toThrow("old State");
      await expect(
        readSnapshot(store, (await block({ v: 1 })).toString()),
      ).rejects.toThrow("publication");
      const invalid = await block({ v: 2, names: { bad: "not-a-link" } });
      await expect(
        readSnapshot(store, (await block({ v: 1, state: invalid })).toString()),
      ).rejects.toThrow("link");
    } finally {
      await store.close();
    }
  });
  it("preserves complete Bundle type checking for Artifact records and original content targets", async () => {
    const store = IpfsStore.fromClient({
      block: { get: () => Promise.reject(new Error("missing")) },
    });
    try {
      const value = {
        value: "bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq",
        timestamp: new Date().toISOString(),
      };
      const root = await jsonBundle(store, artifactType, value);
      expect(await typedJson(store, root, artifactType)).toEqual(value);
      await expect(
        typedJson(store, root, { contentType: "application/json" }),
      ).rejects.toThrow("exact Bundle type");
    } finally {
      await store.close();
    }
  });
});
