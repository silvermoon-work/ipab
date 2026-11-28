import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  importPrivateKeyPkcs8,
  importPublicKeyRaw,
  signEd25519,
  verifyEd25519,
} from "@ipab/bundle/pointer/crypto";
import {
  parseScopeCertificate,
  type ScopeCertificate,
} from "@ipab/bundle/pointer/scope";
import { HostError, object } from "./errors.js";
import type { Identity } from "./identity.js";

export interface EncryptionIdentity {
  publicKey: string;
  privateKey: string;
}
export function encryptionIdentity(): EncryptionIdentity {
  const keys = generateKeyPairSync("x25519");
  return {
    publicKey: keys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
    privateKey: keys.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
  };
}
export interface EnvelopeBinding {
  configUrl: string;
  scopeId: string;
  owner: string;
  member: string;
  requestId: string;
  peerId: string;
  profileId: string;
  headId: string;
  epoch: number;
  encryptionKey: string;
}
export interface MembershipSecret {
  certificate: ScopeCertificate;
  swarmKey: string;
}
export interface Envelope {
  binding: EnvelopeBinding;
  ephemeral: string;
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
  signature: string;
}
export function parseEnvelope(value: unknown): Envelope {
  const envelope = object(value, "approval envelope");
  if (
    Object.keys(envelope).sort().join() !==
    "binding,ciphertext,ephemeral,iv,salt,signature,tag"
  )
    throw new HostError("Invalid approval envelope encoding.");
  const fields = object(envelope.binding, "approval binding");
  if (
    Object.keys(fields).sort().join() !==
    "configUrl,encryptionKey,epoch,headId,member,owner,peerId,profileId,requestId,scopeId"
  )
    throw new HostError("Invalid approval binding.");
  const text = (record: Record<string, unknown>, key: string): string => {
    const field = record[key];
    if (typeof field !== "string")
      throw new HostError("Invalid approval field.");
    return field;
  };
  const epoch = fields.epoch;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new HostError("Invalid approval epoch.");
  const binding: EnvelopeBinding = {
    configUrl: text(fields, "configUrl"),
    scopeId: text(fields, "scopeId"),
    owner: text(fields, "owner"),
    member: text(fields, "member"),
    requestId: text(fields, "requestId"),
    peerId: text(fields, "peerId"),
    profileId: text(fields, "profileId"),
    headId: text(fields, "headId"),
    epoch,
    encryptionKey: text(fields, "encryptionKey"),
  };
  const result: Envelope = {
    binding,
    ephemeral: text(envelope, "ephemeral"),
    salt: text(envelope, "salt"),
    iv: text(envelope, "iv"),
    ciphertext: text(envelope, "ciphertext"),
    tag: text(envelope, "tag"),
    signature: text(envelope, "signature"),
  };
  if (
    ![
      result.ephemeral,
      result.salt,
      result.iv,
      result.ciphertext,
      result.tag,
      result.signature,
    ].every((field) => /^[A-Za-z0-9_-]+$/.test(field)) ||
    result.salt.length !== 43 ||
    result.iv.length !== 16 ||
    result.tag.length !== 22 ||
    result.signature.length !== 86 ||
    result.ciphertext.length > 8192
  )
    throw new HostError("Invalid approval envelope encoding.");
  return result;
}
const message = (e: Omit<Envelope, "signature">) =>
  JSON.stringify([
    "IPAB-APPROVAL/1",
    e.binding,
    e.ephemeral,
    e.salt,
    e.iv,
    e.ciphertext,
    e.tag,
  ]);
function encryptionKey(
  privateKey: string,
  publicKey: string,
  salt: Buffer,
  binding: EnvelopeBinding,
): Buffer {
  const privateObject = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    type: "pkcs8",
    format: "der",
  });
  const publicObject = createPublicKey({
    key: Buffer.from(publicKey, "base64url"),
    type: "spki",
    format: "der",
  });
  if (
    privateObject.asymmetricKeyType !== "x25519" ||
    publicObject.asymmetricKeyType !== "x25519"
  )
    throw new HostError("Approval requires X25519 encryption keys.");
  return Buffer.from(
    hkdfSync(
      "sha256",
      diffieHellman({ privateKey: privateObject, publicKey: publicObject }),
      salt,
      Buffer.from(JSON.stringify(["IPAB-ENVELOPE/1", binding])),
      32,
    ),
  );
}
export async function sealApproval(
  binding: EnvelopeBinding,
  secret: MembershipSecret,
  owner: Identity,
): Promise<Envelope> {
  const ephemeral = encryptionIdentity();
  const salt = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey(ephemeral.privateKey, binding.encryptionKey, salt, binding),
    iv,
  );
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secret), "utf8"),
    cipher.final(),
  ]);
  const envelope = {
    binding,
    ephemeral: ephemeral.publicKey,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
  return {
    ...envelope,
    signature: await signEd25519(
      await importPrivateKeyPkcs8(owner.privateKey),
      message(envelope),
    ),
  };
}
export async function openApproval(
  value: unknown,
  expected: EnvelopeBinding,
  identity: EncryptionIdentity,
): Promise<MembershipSecret> {
  const envelope = parseEnvelope(value);
  if (
    JSON.stringify(envelope.binding) !== JSON.stringify(expected) ||
    expected.encryptionKey !== identity.publicKey ||
    !(await verifyEd25519(
      await importPublicKeyRaw(expected.owner),
      envelope.signature,
      message(envelope),
    ))
  )
    throw new HostError(
      "Approval signature or exact request/resource/identity binding is invalid.",
    );
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(
        identity.privateKey,
        envelope.ephemeral,
        Buffer.from(envelope.salt, "base64url"),
        expected,
      ),
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(JSON.stringify(expected)));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const secret = object(
      JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8"),
      ) as unknown,
      "membership secret",
    );
    if (
      Object.keys(secret).sort().join() !== "certificate,swarmKey" ||
      typeof secret.swarmKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(secret.swarmKey)
    )
      throw new HostError("Invalid membership secret.");
    return {
      certificate: parseScopeCertificate(secret.certificate),
      swarmKey: secret.swarmKey,
    };
  } catch {
    throw new HostError(
      "Could not decrypt the approved package; preserve the original local Request identity.",
    );
  }
}
