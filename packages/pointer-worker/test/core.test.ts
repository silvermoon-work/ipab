import { describe, expect, it } from "vitest";
import {
  EMPTY_BODY_SHA256,
  canonicalService,
  certificateSigningMessage,
  isCanonicalCid,
  isCanonicalPublicKey,
  normalizeScope,
  requestSigningMessage,
  scopeIsSubset,
  scopeToString,
  subjectMatches,
  subjectPatternIsNarrower,
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
import { narrowScope } from "../src/certificates.ts";
import { compareAndSwap, consumeNonce } from "../src/state.ts";
import { ROOT, NOW, makeCert } from "./helpers.ts";

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
        pointerId: "id",
        method: "put",
        path: "/v1/pointers/id",
        timestamp: 42,
        nonce: "abcdefghijklmnopqrstuv",
        bodySha256: "00".repeat(32),
        ifMatch: '"3"',
        idempotencyKey: "retry",
        subject: "pub",
      };
      expect(JSON.parse(requestSigningMessage(p))).toEqual([
        "IPAB-POINTER/2",
        p.service,
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
      expect(requestSigningMessage({ ...p, idempotencyKey: "a\nb" })).not.toBe(
        requestSigningMessage({ ...p, idempotencyKey: "a", subject: "b\npub" }),
      );
    });
    it("signs every member certificate field including ID and audience", async () => {
      const owner = await generateKeyPair(),
        member = await generateKeyPair();
      const cert = await makeCert(owner, member, "id");
      expect(JSON.parse(certificateSigningMessage(cert.body))).toEqual([
        "IPAB-POINTER-CERT/2",
        cert.body.service,
        "id",
        owner.publicRaw,
        member.publicRaw,
        cert.body.cid,
        cert.body.iat,
        cert.body.exp,
      ]);
      expect(
        certificateSigningMessage({ ...cert.body, cid: "another" }),
      ).not.toBe(certificateSigningMessage(cert.body));
    });
    it("serializes scopes without ambiguity", () => {
      expect(scopeToString({ read: true, write: false })).toBe("read:-:*");
      expect(normalizeScope(undefined)).toEqual({ read: false, write: false });
      expect(normalizeScope({ read: true, sub: "a" })).toEqual({
        read: true,
        write: false,
        sub: "a",
      });
      expect(normalizeScope({ read: 1 as unknown as boolean })).toEqual({
        read: false,
        write: false,
      });
    });
    it("rejects scope capabilities that exceed the issuer", () => {
      expect(
        scopeIsSubset(
          { read: true, write: false },
          { read: false, write: true },
        ),
      ).toBe(false);
      expect(
        scopeIsSubset(
          { read: false, write: true },
          { read: true, write: false },
        ),
      ).toBe(false);
      expect(scopeToString({ read: true, write: true, sub: "alice/x" })).toBe(
        "read:write:alice/x",
      );
    });
    it("compares scopes by containment, not equality", () => {
      const full = { read: true, write: true },
        readOnly = { read: true, write: false };
      expect(scopeIsSubset(readOnly, full)).toBe(true);
      expect(scopeIsSubset(full, readOnly)).toBe(false);
      expect(
        scopeIsSubset({ ...full, sub: "alice/x" }, { ...full, sub: "alice/*" }),
      ).toBe(true);
      expect(
        scopeIsSubset({ ...full, sub: "alice/*" }, { ...full, sub: "alice/x" }),
      ).toBe(false);
      expect(
        scopeIsSubset(
          { ...readOnly, sub: "alice/x" },
          { ...full, sub: "alice/x" },
        ),
      ).toBe(true);
    });
    it("only narrows subject patterns it can prove", () => {
      expect(subjectPatternIsNarrower(undefined, undefined)).toBe(true);
      expect(subjectPatternIsNarrower("alice", undefined)).toBe(true);
      expect(subjectPatternIsNarrower(undefined, "alice")).toBe(false);
      expect(subjectPatternIsNarrower("alice/x", "alice/x")).toBe(true);
      expect(subjectPatternIsNarrower("alice/x*", "alice/*")).toBe(true);
      expect(subjectPatternIsNarrower("alice/*", "alice/x*")).toBe(false);
      expect(subjectPatternIsNarrower("alice/x", "alice/*")).toBe(true);
      expect(subjectPatternIsNarrower("alice/x", "alice/?")).toBe(false);
      expect(subjectPatternIsNarrower("alice/x?", "alice/*")).toBe(true);
      expect(subjectPatternIsNarrower("alice/*", "alice/x?")).toBe(false);
    });
    it("matches subject globs without regex injection", () => {
      expect(subjectMatches("alice/*", "alice/agent-1")).toBe(true);
      expect(subjectMatches("alice/?", "alice/a")).toBe(true);
      expect(subjectMatches("alice/?", "alice/ab")).toBe(false);
      expect(subjectMatches(undefined, "anyone")).toBe(true);
      expect(subjectMatches("*", "anyone")).toBe(true);
      expect(subjectMatches("alice/*", "bob/agent-1")).toBe(false);
      expect(subjectMatches("a.*", "aXb")).toBe(false);
      expect(subjectMatches("a+b", "a+b")).toBe(true);
    });
    it("narrows a leaf scope only downwards", () => {
      const scope = { read: true, write: true, sub: "alice/*" };
      expect(narrowScope(scope, null)).toEqual(scope);
      expect(narrowScope(scope, { read: true, write: false })).toEqual({
        read: true,
        write: false,
        sub: "alice/*",
      });
      expect(
        narrowScope({ read: true, write: false }, { read: true, write: true }),
      ).toBeNull();
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
    it("CAS uses arbitrary precision revisions and prevents ABA", () => {
      expect(
        compareAndSwap(
          { root: ROOT, revision: "999999999999999999" },
          ROOT,
          "999999999999999999",
        ),
      ).toEqual({
        status: 200,
        state: { root: ROOT, revision: "1000000000000000000" },
      });
      expect(
        compareAndSwap({ root: ROOT, revision: "3" }, ROOT, "1").status,
      ).toBe(412);
    });
  },
);
