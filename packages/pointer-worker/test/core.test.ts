import { describe, expect, it } from "vitest";
import {
  EMPTY_BODY_SHA256,
  canonicalService,
  isCanonicalCid,
  isCanonicalPublicKey,
} from "../src/protocol.ts";
import {
  decodeText,
  fromBase64Url,
  fromHex,
  generateKeyPair,
  importPrivateKeyPkcs8,
  importPublicKeyRaw,
  keyId,
  loadTrustAnchor,
  publicKeyToPem,
  randomBytes,
  sha256,
  sha256Hex,
  signEd25519,
  toBase64Url,
  toHex,
  utf8,
  verifyEd25519,
} from "../src/crypto.ts";
import {
  scopeCertificateMessage,
  scopeSigningMessage,
  issueScopeCertificate,
  uniqueId,
  valueCid,
  verifyScopeCertificate,
} from "@ipab/bundle/pointer/scope";
import { consumeNonce } from "../src/state.ts";
import { ROOT, NOW } from "./helpers.ts";

describe(
  "protocol and retained crypto/scope utilities",
  { tags: ["unit"] },
  () => {
    it("round-trips base64url and rejects junk", () => {
      const bytes = randomBytes(64),
        encoded = toBase64Url(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
      expect(() => fromBase64Url("not base64!!")).toThrow("invalid base64url");
    });
    it("round-trips hex and rejects odd input", () => {
      expect(toHex(fromHex("00ff10"))).toBe("00ff10");
      expect(fromHex("00ff10").byteLength).toBe(3);
      expect(() => fromHex("abc")).toThrow("invalid hex");
    });
    it("packages Ed25519 keys as valid PKCS#8 and SPKI", async () => {
      const keys = await generateKeyPair(),
        pem = publicKeyToPem(keys.publicRaw);
      expect(pem).toContain("BEGIN PUBLIC KEY");
      expect((await loadTrustAnchor(pem)).publicRaw).toBe(keys.publicRaw);
      expect((await loadTrustAnchor(pem)).publicRaw).toBe(keys.publicRaw);
      const jwk = await loadTrustAnchor(
        JSON.stringify({ kty: "OKP", crv: "Ed25519", x: keys.publicRaw }),
      );
      expect(jwk.publicRaw).toBe(keys.publicRaw);
      await importPrivateKeyPkcs8(keys.privatePkcs8);
    });
    it("rejects trust anchors that are not 32-byte Ed25519 keys", async () => {
      await expect(loadTrustAnchor("AAAA")).rejects.toThrow(
        "must be a 32-byte Ed25519 key",
      );
      await expect(
        loadTrustAnchor(
          JSON.stringify({ kty: "RSA", crv: "Ed25519", x: "AA" }),
        ),
      ).rejects.toThrow("Ed25519 OKP public key");
      await expect(
        loadTrustAnchor(
          "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
        ),
      ).rejects.toThrow("SubjectPublicKeyInfo");
      await expect(importPublicKeyRaw(randomBytes(31))).rejects.toThrow(
        "must be 32 bytes",
      );
    });
    it("signs an unambiguous complete request tuple", () => {
      const p = {
        service: "https://pointer.example",
        scopeId: "scope",
        variableId: "id",
        method: "put",
        path: "/v1/scope/id",
        timestamp: 42,
        nonce: "abcdefghijklmnopqrstuv",
        bodySha256: "00".repeat(32),
        ifMatch: '"3"',
        idempotencyKey: "retry",
        subject: "pub",
      };
      expect(JSON.parse(scopeSigningMessage(p))).toEqual([
        "IPAB-SCOPE/1",
        p.service,
        "scope",
        "id",
        "PUT",
        p.path,
        p.bodySha256,
        '"3"',
        "retry",
        42,
        p.nonce,
        "pub",
      ]);
      expect(scopeSigningMessage({ ...p, idempotencyKey: "a\nb" })).not.toBe(
        scopeSigningMessage({ ...p, idempotencyKey: "a", subject: "b\npub" }),
      );
    });
    it("signs every member certificate field including ID and audience", async () => {
      const owner = await generateKeyPair(),
        member = await generateKeyPair();
      const cert = await issueScopeCertificate(
        {
          v: 1,
          service: "https://pointer.example",
          scopeId: "scope",
          subject: member.publicRaw,
          write: ["id"],
        },
        owner.privateKey,
      );
      expect(JSON.parse(scopeCertificateMessage(cert.body))).toEqual([
        "IPAB-SCOPE-CERT/1",
        cert.body.service,
        "scope",
        member.publicRaw,
        ["id"],
      ]);
      expect(
        scopeCertificateMessage({ ...cert.body, write: ["another"] }),
      ).not.toBe(scopeCertificateMessage(cert.body));
    });
    it("does not grant wildcard or read/management capabilities", async () => {
      const owner = await generateKeyPair(),
        member = await generateKeyPair(),
        scopeId = uniqueId(),
        id = uniqueId();
      const cert = await issueScopeCertificate(
        {
          v: 1,
          service: "https://pointer.example",
          scopeId,
          subject: member.publicRaw,
          write: ["*"],
        },
        owner.privateKey,
      );
      await expect(
        verifyScopeCertificate(
          cert,
          owner.publicRaw,
          cert.body.service,
          scopeId,
          id,
          member.publicRaw,
        ),
      ).rejects.toThrow("certificate");
    });
    it("rejects subject impersonation under a valid certificate", async () => {
      const owner = await generateKeyPair(),
        member = await generateKeyPair(),
        scopeId = uniqueId(),
        id = uniqueId();
      const cert = await issueScopeCertificate(
        {
          v: 1,
          service: "https://pointer.example",
          scopeId,
          subject: member.publicRaw,
          write: [id],
        },
        owner.privateKey,
      );
      await expect(
        verifyScopeCertificate(
          cert,
          owner.publicRaw,
          cert.body.service,
          scopeId,
          id,
          owner.publicRaw,
        ),
      ).rejects.toThrow("certificate");
    });
    it("allows exactly granted IDs, never lexical prefix containment", async () => {
      const owner = await generateKeyPair(),
        member = await generateKeyPair(),
        scopeId = uniqueId(),
        id = uniqueId();
      const cert = await issueScopeCertificate(
        {
          v: 1,
          service: "https://pointer.example",
          scopeId,
          subject: member.publicRaw,
          write: [id],
        },
        owner.privateKey,
      );
      await verifyScopeCertificate(
        cert,
        owner.publicRaw,
        cert.body.service,
        scopeId,
        id,
        member.publicRaw,
      );
      await expect(
        verifyScopeCertificate(
          cert,
          owner.publicRaw,
          cert.body.service,
          scopeId,
          id.slice(0, -1) + "x",
          member.publicRaw,
        ),
      ).rejects.toThrow("certificate");
    });
    it("canonical JSON identity ignores property insertion order", async () => {
      expect(await valueCid({ a: true, b: null })).toBe(
        await valueCid({ b: null, a: true }),
      );
    });
    it("rejects unpaired Unicode and unsafe/nonfinite numeric values", async () => {
      for (const value of ["\ud800", "\udc00", Infinity, NaN, 2 ** 53])
        await expect(valueCid(value)).rejects.toThrow();
    });
    it("bounds encoding size and depth without excluding valid null/boolean/arrays", async () => {
      await valueCid([null, true, false, "hello", 1.5]);
      await expect(valueCid("x".repeat(65536))).rejects.toThrow("64 KiB");
      let value: unknown = null;
      for (let i = 0; i < 34; i++) value = [value];
      await expect(valueCid(value)).rejects.toThrow("complexity");
    });
    it("hashes bodies with SHA-256", async () => {
      expect(await sha256Hex("")).toBe(EMPTY_BODY_SHA256);
      expect(await sha256Hex("")).toHaveLength(64);
      expect(decodeText(utf8("héllo"))).toBe("héllo");
      expect(await sha256Hex(utf8("x"))).toBe(await sha256Hex("x"));
    });
    it("verifies Ed25519 signatures defensively", async () => {
      const keys = await generateKeyPair(),
        privateKey = await importPrivateKeyPkcs8(keys.privatePkcs8);
      const signature = await signEd25519(privateKey, "hello");
      expect(await verifyEd25519(keys.publicKey, signature, "hello")).toBe(
        true,
      );
      expect(await verifyEd25519(keys.publicKey, signature, "bye")).toBe(false);
      expect(await verifyEd25519(keys.publicKey, "AAAA", "hello")).toBe(false);
      expect(await verifyEd25519(keys.publicKey, "!!", "hello")).toBe(false);
    });
    it("derives the key ID from the raw public key", async () => {
      const keys = await generateKeyPair();
      expect(await keyId(keys.publicRaw)).toBe(
        toBase64Url(
          new Uint8Array(await sha256(fromBase64Url(keys.publicRaw))),
        ),
      );
    });
    it("accepts only canonical full keys and real canonical CIDs", async () => {
      const keys = await generateKeyPair();
      expect(isCanonicalPublicKey(keys.publicRaw)).toBe(true);
      expect(isCanonicalPublicKey("A".repeat(42) + "B")).toBe(false);
      expect(isCanonicalPublicKey(null)).toBe(false);
      expect(isCanonicalPublicKey("AAAA")).toBe(false);
      expect(isCanonicalCid(ROOT)).toBe(true);
      for (const value of [
        "not-a-cid",
        ROOT.toUpperCase(),
        "b".repeat(257),
        42,
      ])
        expect(isCanonicalCid(value)).toBe(false);
    });
    it("requires canonical origins, permitting loopback HTTP only", () => {
      for (const value of [
        "https://example.com",
        "http://127.0.0.1:8787",
        "http://localhost:8787",
        "http://[::1]:8787",
      ])
        expect(canonicalService(value)).toBe(value);
      for (const value of [
        "http://example.com",
        "https://example.com/",
        "https://example.com/path",
        "https://x:password@example.com",
        "https://example.com?q=x",
        "https://example.com#x",
        "https://EXAMPLE.COM",
        "ftp://example.com",
        "https://example.com:443",
      ])
        expect(() => canonicalService(value)).toThrow();
    });
    it("consumes nonces without evicting live entries and rejects captured proofs", () => {
      const first = consumeNonce({}, "nonce", NOW);
      expect(first).toEqual({ nonce: NOW + 130 });
      expect(() => consumeNonce(first, "nonce", NOW + 129)).toThrow(
        "nonce already used",
      );
      expect(consumeNonce(first, "nonce", NOW + 130)).toEqual({
        nonce: NOW + 260,
      });
    });
    it("content identity has no history revision so returning to A restores the same CAS token", async () => {
      const a = await valueCid({ root: "A" }),
        b = await valueCid({ root: "B" });
      expect(a).not.toBe(b);
      expect(await valueCid({ root: "A" })).toBe(a);
    });
  },
);
