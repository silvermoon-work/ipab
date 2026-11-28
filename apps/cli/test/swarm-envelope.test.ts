import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { generateKeyPair } from "@ipab/bundle/pointer/crypto";
import { issueScopeCertificate, uniqueId } from "@ipab/bundle/pointer/scope";
import {
  encryptionIdentity,
  sealApproval,
  openApproval,
  type EnvelopeBinding,
} from "../src/swarm-envelope.js";

async function envelopeFixture() {
  const owner = await generateKeyPair(),
    subject = await generateKeyPair(),
    encryption = encryptionIdentity();
  const binding: EnvelopeBinding = {
    configUrl: `https://scope.example/v1/${uniqueId()}/${uniqueId()}`,
    scopeId: uniqueId(),
    owner: owner.publicRaw,
    member: subject.publicRaw,
    requestId: uniqueId(),
    peerId: "peer",
    profileId: uniqueId(),
    headId: uniqueId(),
    epoch: 1,
    encryptionKey: encryption.publicKey,
  };
  const certificate = await issueScopeCertificate(
    {
      v: 1,
      service: "https://scope.example",
      scopeId: binding.scopeId,
      subject: subject.publicRaw,
      write: [binding.headId, binding.profileId],
    },
    owner.privateKey,
  );
  const secret = { certificate, swarmKey: "a1".repeat(32) };
  const identity = {
    publicKey: owner.publicRaw,
    privateKey: owner.privatePkcs8,
  };
  return {
    owner,
    binding,
    encryption,
    secret,
    identity,
    envelope: await sealApproval(binding, secret, identity),
  };
}
describe("approval envelope failure boundaries", { tags: ["unit"] }, () => {
  it("rejects malformed envelopes and bindings before any decryption", async () => {
    const f = await envelopeFixture();
    const missingTag = Object.fromEntries(
      Object.entries(f.envelope).filter(([key]) => key !== "tag"),
    );
    const missingHead = Object.fromEntries(
      Object.entries(f.binding).filter(([key]) => key !== "headId"),
    );
    for (const invalid of [
      null,
      [],
      missingTag,
      { ...f.envelope, extra: true },
      { ...f.envelope, binding: null },
      { ...f.envelope, binding: missingHead },
      { ...f.envelope, binding: { ...f.binding, member: 123 } },
      { ...f.envelope, binding: { ...f.binding, epoch: "1" } },
      { ...f.envelope, binding: { ...f.binding, epoch: 0 } },
      { ...f.envelope, binding: { ...f.binding, epoch: 1.5 } },
      { ...f.envelope, ciphertext: null },
      { ...f.envelope, ephemeral: "bad!" },
      { ...f.envelope, salt: "a" },
      { ...f.envelope, iv: "a" },
      { ...f.envelope, tag: "a" },
      { ...f.envelope, signature: "a" },
      { ...f.envelope, ciphertext: "a".repeat(8193) },
    ])
      await expect(
        openApproval(invalid, f.binding, f.encryption),
      ).rejects.toThrow();
  });
  it("rejects a valid signature for a different recipient or changed request/resource binding", async () => {
    const f = await envelopeFixture();
    await expect(
      openApproval(f.envelope, f.binding, {
        ...f.encryption,
        publicKey: encryptionIdentity().publicKey,
      }),
    ).rejects.toThrow("binding");
    for (const change of [
      { configUrl: "https://different.example" },
      { headId: uniqueId() },
      { profileId: uniqueId() },
      { scopeId: uniqueId() },
      { member: f.owner.publicRaw },
      { requestId: uniqueId() },
      { epoch: 2 },
    ]) {
      await expect(
        openApproval(f.envelope, { ...f.binding, ...change }, f.encryption),
      ).rejects.toThrow("binding");
    }
    await expect(
      openApproval(
        { ...f.envelope, signature: "A".repeat(86) },
        f.binding,
        f.encryption,
      ),
    ).rejects.toThrow("signature");
  });
  it("never treats Ed25519 signing keys as X25519 encryption keys", async () => {
    const f = await envelopeFixture(),
      wrong = generateKeyPairSync("ed25519");
    const publicKey = wrong.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    const privateKey = wrong.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url");
    await expect(
      sealApproval(
        { ...f.binding, encryptionKey: publicKey },
        f.secret,
        f.identity,
      ),
    ).rejects.toThrow("X25519");
    await expect(
      openApproval(f.envelope, f.binding, { ...f.encryption, privateKey }),
    ).rejects.toThrow("decrypt");
  });
  it("rejects authenticated encrypted plaintext that contains an invalid key or certificate", async () => {
    const f = await envelopeFixture();
    const badKey = await sealApproval(
      f.binding,
      { ...f.secret, swarmKey: "not-a-key" },
      f.identity,
    );
    await expect(openApproval(badKey, f.binding, f.encryption)).rejects.toThrow(
      "decrypt",
    );
    const badCertificate = {
      ...f.secret.certificate,
      body: { ...f.secret.certificate.body, write: ["*"] },
    };
    const badGrant = await sealApproval(
      f.binding,
      { ...f.secret, certificate: badCertificate },
      f.identity,
    );
    await expect(
      openApproval(badGrant, f.binding, f.encryption),
    ).rejects.toThrow("decrypt");
  });
});
