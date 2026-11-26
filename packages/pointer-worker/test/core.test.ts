import { describe, expect, it } from "vitest";
import {
  EMPTY_BODY_SHA256,
  ERROR_CODES,
  MAX_VALUE_BYTES,
  PROTOCOL_VERSION,
  certificateSigningMessage,
  isValidVariableName,
  normalizeScope,
  requestSigningMessage,
  scopeIsSubset,
  scopeToString,
  subjectMatches,
  subjectPatternIsNarrower,
  type Certificate,
  type DelegatedScope,
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
  encodeCertificate,
  narrowScope,
  verifyCertificateChain,
} from "../src/certificates.ts";
import { authenticate } from "../src/verify.ts";
import { EMPTY_POINTER, execute, type OpRequest } from "../src/state.ts";
import { NOW, authContext, makeCert, signedRequest, world } from "./helpers.ts";

describe("protocol", () => {
  it("round-trips base64url and rejects junk", { tags: ["unit"] }, () => {
    const bytes = randomBytes(64);
    const encoded = toBase64Url(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
    expect(() => fromBase64Url("not base64!!")).toThrow("invalid base64url");
  });

  it("round-trips hex and rejects odd input", { tags: ["unit"] }, () => {
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
    expect(fromHex("00ff10").byteLength).toBe(3);
    expect(() => fromHex("abc")).toThrow("invalid hex");
  });

  it(
    "packages the Ed25519 key as valid PKCS#8 and SPKI",
    { tags: ["unit"] },
    async () => {
      const keys = await generateKeyPair();
      const pem = publicKeyToPem(keys.publicRaw);
      expect(pem).toContain("BEGIN PUBLIC KEY");
      expect((await loadTrustAnchor(pem)).publicRaw).toBe(keys.publicRaw);
      const fromJwk = await loadTrustAnchor(
        JSON.stringify({ kty: "OKP", crv: "Ed25519", x: keys.publicRaw }),
      );
      expect(fromJwk.publicRaw).toBe(keys.publicRaw);
      await importPrivateKeyPkcs8(keys.privatePkcs8);
    },
  );

  it(
    "rejects trust anchors that are not 32-byte Ed25519 keys",
    { tags: ["unit"] },
    async () => {
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
    },
  );

  it("signs a stable canonical request string", { tags: ["unit"] }, () => {
    const message = requestSigningMessage({
      method: "put",
      path: "/v1/value",
      timestamp: 42,
      nonce: "abcdefghijklmnop",
      bodySha256: "00".repeat(32),
      ifMatch: '"3"',
      subject: "alice/agent-1",
    });
    expect(message).toBe(
      `DSH-POINTER/1\nPUT\n/v1/value\n42\nabcdefghijklmnop\n${"00".repeat(32)}\n"3"\nalice/agent-1`,
    );
  });

  it("signs every certificate field", { tags: ["unit"] }, () => {
    const message = certificateSigningMessage({
      v: 1,
      sub: "alice/agent-1",
      pub: "pub",
      scope: { read: true, write: false, sub: "alice/*" },
      iss: "alice",
      iss_pub: "root",
      kid: "kid",
      cid: "cid",
      iat: 1,
      exp: 2,
      ca: true,
    });
    expect(message).toBe(
      "DSH-POINTER-CERT/1\nalice/agent-1\npub\nread:-:alice/*\nalice\nroot\nkid\ncid\n1\n2\nca",
    );
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("serializes scopes without ambiguity", { tags: ["unit"] }, () => {
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

  it("rejects a scope that removes a capability", { tags: ["unit"] }, () => {
    expect(
      scopeIsSubset({ read: true, write: false }, { read: false, write: true }),
    ).toBe(false);
    expect(
      scopeIsSubset({ read: false, write: true }, { read: true, write: false }),
    ).toBe(false);
    expect(scopeToString({ read: true, write: true, sub: "alice/x" })).toBe(
      "read:write:alice/x",
    );
  });

  it("compares scopes by containment, not equality", { tags: ["unit"] }, () => {
    const full: DelegatedScope = { read: true, write: true };
    const readOnly: DelegatedScope = { read: true, write: false };
    expect(scopeIsSubset(readOnly, full)).toBe(true);
    expect(scopeIsSubset(full, readOnly)).toBe(false);
    expect(
      scopeIsSubset(
        { read: true, write: true, sub: "alice/x" },
        { read: true, write: true, sub: "alice/*" },
      ),
    ).toBe(true);
    expect(
      scopeIsSubset(
        { read: true, write: true, sub: "alice/*" },
        { read: true, write: true, sub: "alice/x" },
      ),
    ).toBe(false);
    expect(
      scopeIsSubset(
        { read: true, write: false, sub: "alice/x" },
        { read: true, write: true, sub: "alice/x" },
      ),
    ).toBe(true);
  });

  it("only narrows subject patterns it can prove", { tags: ["unit"] }, () => {
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

  it(
    "matches subject globs without regex injection",
    { tags: ["unit"] },
    () => {
      expect(subjectMatches("alice/*", "alice/agent-1")).toBe(true);
      expect(subjectMatches("alice/?", "alice/a")).toBe(true);
      expect(subjectMatches("alice/?", "alice/ab")).toBe(false);
      expect(subjectMatches(undefined, "anyone")).toBe(true);
      expect(subjectMatches("*", "anyone")).toBe(true);
      expect(subjectMatches("alice/*", "bob/agent-1")).toBe(false);
      expect(subjectMatches("a.*", "aXb")).toBe(false);
      expect(subjectMatches("a+b", "a+b")).toBe(true);
    },
  );

  it("hashes bodies with SHA-256", { tags: ["unit"] }, async () => {
    expect(await sha256Hex("")).toBe(EMPTY_BODY_SHA256);
    expect(await sha256Hex("")).toHaveLength(64);
    expect(decodeText(utf8("héllo"))).toBe("héllo");
    expect(await sha256Hex(utf8("x"))).toBe(await sha256Hex("x"));
  });

  it(
    "verifies Ed25519 signatures defensively",
    { tags: ["unit"] },
    async () => {
      const keys = await generateKeyPair();
      const privateKey = await importPrivateKeyPkcs8(keys.privatePkcs8);
      const signature = await signEd25519(privateKey, "hello");
      expect(await verifyEd25519(keys.publicKey, signature, "hello")).toBe(
        true,
      );
      expect(await verifyEd25519(keys.publicKey, signature, "bye")).toBe(false);
      expect(await verifyEd25519(keys.publicKey, "AAAA", "hello")).toBe(false);
      expect(await verifyEd25519(keys.publicKey, "!!", "hello")).toBe(false);
    },
  );

  it(
    "derives the key id from the raw public key",
    { tags: ["unit"] },
    async () => {
      const keys = await generateKeyPair();
      const raw = fromBase64Url(keys.publicRaw);
      expect(await keyId(keys.publicRaw)).toBe(
        toBase64Url(new Uint8Array(await sha256(raw))),
      );
    },
  );

  it(
    "validates variable names and reserves control paths",
    { tags: ["unit"] },
    () => {
      expect(isValidVariableName("test-ptr")).toBe(true);
      expect(isValidVariableName("a")).toBe(true);
      expect(isValidVariableName("Bad")).toBe(false);
      expect(isValidVariableName("-bad")).toBe(false);
      expect(isValidVariableName("a/b")).toBe(false);
      expect(isValidVariableName("admin")).toBe(false);
      expect(isValidVariableName("_admin")).toBe(false);
      expect(isValidVariableName("health")).toBe(false);
      expect(isValidVariableName("v1")).toBe(false);
      expect(isValidVariableName("a".repeat(41))).toBe(true);
      expect(isValidVariableName("a".repeat(42))).toBe(false);
    },
  );
});

describe("certificate chains", () => {
  it(
    "accepts a two-hop chain anchored at the pinned key",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const result = await verifyCertificateChain(
        w.agent1.chain.map(encodeCertificate),
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.leaf.sub).toBe("alice/agent-1");
        expect(result.scope).toEqual({
          read: true,
          write: true,
          sub: "alice/agent-1",
        });
        expect(result.chain).toHaveLength(2);
      }
    },
  );

  it("accepts a three-hop chain", { tags: ["unit"] }, async () => {
    const w = await world();
    const result = await verifyCertificateChain(
      w.agent2.chain.map(encodeCertificate),
      w.anchor.publicKey,
      NOW,
      60,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an empty or oversized chain", { tags: ["unit"] }, async () => {
    const w = await world();
    const empty = await verifyCertificateChain([], w.anchor.publicKey, NOW, 60);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toMatch(/empty/);

    const encoded = w.agent1.chain.map(encodeCertificate);
    const tooDeep = await verifyCertificateChain(
      new Array(6).fill(encoded[0]) as string[],
      w.anchor.publicKey,
      NOW,
      60,
    );
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.message).toMatch(/deeper/);
  });

  it("rejects malformed certificates", { tags: ["unit"] }, async () => {
    const w = await world();
    const notBase64 = await verifyCertificateChain(
      ["%%%"],
      w.anchor.publicKey,
      NOW,
      60,
    );
    expect(notBase64.ok).toBe(false);
    if (!notBase64.ok) {
      expect(notBase64.code).toBe("cert_invalid");
      expect(notBase64.index).toBe(0);
    }

    const notJson = toBase64Url(utf8("{}"));
    const broken = await verifyCertificateChain(
      [notJson],
      w.anchor.publicKey,
      NOW,
      60,
    );
    expect(broken.ok).toBe(false);

    const partial = toBase64Url(
      utf8(JSON.stringify({ body: { v: 1 }, sig: "x" })),
    );
    const incomplete = await verifyCertificateChain(
      [partial],
      w.anchor.publicKey,
      NOW,
      60,
    );
    expect(incomplete.ok).toBe(false);
  });

  it(
    "rejects a CA as the signer's certificate",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const result = await verifyCertificateChain(
        [encodeCertificate(w.ca)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/must not be a CA/);
    },
  );

  it(
    "rejects a chain that does not reach the anchor",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const other = await generateKeyPair();
      const strayLeaf = await makeCert(
        { keys: await generateKeyPair(), chain: [], subject: "alice" },
        { keys: other, subject: "alice/agent-1" },
        { read: true, write: true },
      );
      const result = await verifyCertificateChain(
        [encodeCertificate(strayLeaf)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("cert_invalid");
    },
  );

  it("rejects a tampered certificate body", { tags: ["unit"] }, async () => {
    const w = await world();
    const leaf = JSON.parse(JSON.stringify(w.agent1.chain[0])) as Certificate;
    leaf.body.sub = "alice/evil";
    const chain = [encodeCertificate(leaf), encodeCertificate(w.ca)];
    const result = await verifyCertificateChain(
      chain,
      w.anchor.publicKey,
      NOW,
      60,
    );
    expect(result.ok).toBe(false);
  });

  it(
    "rejects a subject outside the certificate's own scope",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const keys = await generateKeyPair();
      const cert = await makeCert(
        { keys: w.root, chain: [w.ca], subject: "alice" },
        { keys, subject: "alice/agent-1" },
        { read: true, write: true, sub: "alice/other/*" },
      );
      const result = await verifyCertificateChain(
        [encodeCertificate(cert), encodeCertificate(w.ca)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/outside its own scope/);
    },
  );

  it(
    "rejects a child whose scope exceeds its issuer",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const rootPrivate = await importPrivateKeyPkcs8(w.root.privatePkcs8);
      const keys = await generateKeyPair();
      const greedy = await makeCert(
        { keys: w.root, chain: [w.ca], subject: "alice" },
        { keys, subject: "alice/greedy" },
        { read: true, write: true },
      );
      greedy.body.scope = { read: true, write: true, sub: "*" };
      greedy.sig = await signEd25519(
        rootPrivate,
        certificateSigningMessage(greedy.body),
      );
      const result = await verifyCertificateChain(
        [encodeCertificate(greedy), encodeCertificate(w.ca)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/may not issue|exceeds/);
      }
    },
  );

  it(
    "rejects issuer discontinuity, non-CA parents and outliving children",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const keys = await generateKeyPair();
      const leaf = await makeCert(
        { keys: w.root, chain: [w.ca], subject: "alice" },
        { keys, subject: "alice/agent-1" },
        { read: true, write: true },
      );

      const wrongIssuer = JSON.parse(JSON.stringify(leaf)) as Certificate;
      wrongIssuer.body.iss = "someone-else";
      const mismatch = await verifyCertificateChain(
        [encodeCertificate(wrongIssuer), encodeCertificate(w.ca)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok)
        expect(mismatch.message).toMatch(/issuer does not match/);

      const notCa = JSON.parse(JSON.stringify(w.ca)) as Certificate;
      notCa.body.ca = false;
      const nonCaParent = await verifyCertificateChain(
        [encodeCertificate(leaf), encodeCertificate(notCa)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(nonCaParent.ok).toBe(false);
      if (!nonCaParent.ok) expect(nonCaParent.message).toMatch(/not allowed/);

      const longLeaf = JSON.parse(JSON.stringify(leaf)) as Certificate;
      longLeaf.body.exp = w.ca.body.exp + 3600;
      const rootPrivate = await importPrivateKeyPkcs8(w.root.privatePkcs8);
      longLeaf.sig = await signEd25519(
        rootPrivate,
        certificateSigningMessage(longLeaf.body),
      );
      const outlives = await verifyCertificateChain(
        [encodeCertificate(longLeaf), encodeCertificate(w.ca)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(outlives.ok).toBe(false);
      if (!outlives.ok) expect(outlives.message).toMatch(/outlives/);
    },
  );

  it(
    "rejects an empty validity window and an invalid signature",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const keys = await generateKeyPair();
      const empty = await makeCert(
        { keys: w.root, chain: [w.ca], subject: "alice" },
        { keys, subject: "alice/empty" },
        { read: true, write: true },
        { iat: NOW, exp: NOW },
      );
      const emptyWindow = await verifyCertificateChain(
        [encodeCertificate(empty), encodeCertificate(w.ca)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(emptyWindow.ok).toBe(false);
      if (!emptyWindow.ok)
        expect(emptyWindow.message).toMatch(/empty validity window/);

      const tampered = JSON.parse(
        JSON.stringify(w.agent1.chain[0]),
      ) as Certificate;
      tampered.sig = toBase64Url(randomBytes(64));
      const badSignature = await verifyCertificateChain(
        [encodeCertificate(tampered), encodeCertificate(w.ca)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(badSignature.ok).toBe(false);
      if (!badSignature.ok)
        expect(badSignature.message).toMatch(/signature is invalid/);
    },
  );

  it(
    "rejects a child subject outside the issuer's scope",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const narrowKeys = await generateKeyPair();
      const narrowCa = await makeCert(
        { keys: w.root, chain: [w.ca], subject: "alice" },
        { keys: narrowKeys, subject: "alice/narrow" },
        { read: true, write: true, sub: "alice/narrow" },
        { ca: true },
      );
      const childKeys = await generateKeyPair();
      const child = await makeCert(
        { keys: narrowKeys, chain: [narrowCa], subject: "alice/narrow" },
        { keys: childKeys, subject: "alice/other" },
        { read: true, write: true },
      );
      const result = await verifyCertificateChain(
        [
          encodeCertificate(child),
          encodeCertificate(narrowCa),
          encodeCertificate(w.ca),
        ],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/may not issue/);
    },
  );

  it(
    "rejects an expired or not-yet-valid certificate",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const expired = await verifyCertificateChain(
        w.agent1.chain.map(encodeCertificate),
        w.anchor.publicKey,
        NOW + 7200,
        60,
      );
      expect(expired.ok).toBe(false);
      if (!expired.ok) expect(expired.code).toBe("cert_expired");

      const keys = await generateKeyPair();
      const future = await makeCert(
        { keys: w.root, chain: [w.ca], subject: "alice" },
        { keys, subject: "alice/future" },
        { read: true, write: true },
        { iat: NOW + 600, exp: NOW + 1200 },
      );
      const notYet = await verifyCertificateChain(
        [encodeCertificate(future), encodeCertificate(w.ca)],
        w.anchor.publicKey,
        NOW,
        60,
      );
      expect(notYet.ok).toBe(false);
      if (!notYet.ok) expect(notYet.code).toBe("cert_not_yet_valid");
    },
  );

  it(
    "narrows a leaf scope without inventing a subject pattern",
    { tags: ["unit"] },
    () => {
      expect(
        narrowScope({ read: true, write: true }, { read: true, write: false }),
      ).toEqual({
        read: true,
        write: false,
      });
    },
  );

  it("narrows a leaf scope only downwards", { tags: ["unit"] }, () => {
    const leaf: DelegatedScope = { read: true, write: true, sub: "alice/x" };
    expect(narrowScope(leaf, null)).toEqual(leaf);
    expect(narrowScope(leaf, { read: true, write: false })).toEqual({
      read: true,
      write: false,
      sub: "alice/x",
    });
    expect(
      narrowScope(
        { read: true, write: false, sub: "alice/x" },
        {
          read: true,
          write: true,
        },
      ),
    ).toBeNull();
  });
});

describe("request authentication", () => {
  const envFor = (anchorRaw: string) => ({
    POINTER_ROOT_PUBLIC_KEY: anchorRaw,
  });

  it("authenticates direct anchor signing", { tags: ["unit"] }, async () => {
    const w = await world();
    const request = await signedRequest({ key: w.root, subject: "alice" });
    const result = await authenticate(request, envFor(w.root.publicRaw), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.subject).toBe("alice");
      expect(result.auth.direct).toBe(true);
      expect(result.auth.scope).toEqual({ read: true, write: true });
    }
  });

  it(
    "authenticates a certificate-backed request",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const request = await signedRequest({
        key: w.agent1.keys,
        chain: w.agent1.chain,
        signWith: w.agent1.keys,
      });
      const result = await authenticate(request, envFor(w.root.publicRaw), NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.auth.subject).toBe("alice/agent-1");
        expect(result.auth.direct).toBe(false);
        expect(result.auth.certId).toBe(w.agent1.chain[0]!.body.cid);
      }
    },
  );

  it(
    "rejects missing, malformed and oversized signatures",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const env = envFor(w.root.publicRaw);
      expect(
        (
          await authenticate(
            new Request("https://pointer.example/v1/value"),
            env,
            NOW,
          )
        ).ok,
      ).toBe(false);

      const wrongScheme = await signedRequest({ key: w.root });
      wrongScheme.headers.set("authorization", "Bearer abc");
      const scheme = await authenticate(wrongScheme, env, NOW);
      expect(scheme.ok).toBe(false);
      if (!scheme.ok) expect(scheme.code).toBe(ERROR_CODES.unauthorized);

      const shortSig = await signedRequest({ key: w.root });
      shortSig.headers.set("authorization", "Ed25519 AAAA");
      const short = await authenticate(shortSig, env, NOW);
      expect(short.ok).toBe(false);
      if (!short.ok) expect(short.message).toMatch(/64 base64url bytes/);

      const extra = await signedRequest({ key: w.root });
      extra.headers.set(
        "authorization",
        `${extra.headers.get("authorization")} extra`,
      );
      const parts = await authenticate(extra, env, NOW);
      expect(parts.ok).toBe(false);
    },
  );

  it("rejects bad timestamps and nonces", { tags: ["unit"] }, async () => {
    const w = await world();
    const env = envFor(w.root.publicRaw);

    const noTimestamp = await signedRequest({ key: w.root });
    noTimestamp.headers.delete("x-pointer-timestamp");
    const missing = await authenticate(noTimestamp, env, NOW);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe(ERROR_CODES.badRequest);

    const fractional = await signedRequest({ key: w.root });
    fractional.headers.set("x-pointer-timestamp", "1.5");
    const notInteger = await authenticate(fractional, env, NOW);
    expect(notInteger.ok).toBe(false);

    const stale = await signedRequest({ key: w.root, timestamp: NOW - 300 });
    const skew = await authenticate(stale, env, NOW);
    expect(skew.ok).toBe(false);
    if (!skew.ok) expect(skew.message).toMatch(/clock skew/);

    const shortNonce = await signedRequest({ key: w.root });
    shortNonce.headers.set("x-pointer-nonce", "short");
    const nonce = await authenticate(shortNonce, env, NOW);
    expect(nonce.ok).toBe(false);
    if (!nonce.ok) expect(nonce.message).toMatch(/16..128/);
  });

  it(
    "rejects a request whose body or path was changed after signing",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const env = envFor(w.root.publicRaw);
      const request = await signedRequest({
        method: "PUT",
        body: '{"value":"one"}',
        key: w.root,
      });
      const tampered = new Request(request.url, {
        method: "PUT",
        headers: request.headers,
        body: '{"value":"two"}',
      });
      const bodyResult = await authenticate(tampered, env, NOW);
      expect(bodyResult.ok).toBe(false);
      if (!bodyResult.ok)
        expect(bodyResult.code).toBe(ERROR_CODES.unauthorized);

      const moved = new Request("https://pointer.example/admin", {
        method: "GET",
        headers: request.headers,
      });
      expect((await authenticate(moved, env, NOW)).ok).toBe(false);
    },
  );

  it("rejects unusable trust anchors", { tags: ["unit"] }, async () => {
    const w = await world();
    const request = await signedRequest({ key: w.root });
    const result = await authenticate(
      request,
      { POINTER_ROOT_PUBLIC_KEY: "not-a-key" },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not configured|unusable/);
  });

  it("requires a printable subject claim", { tags: ["unit"] }, async () => {
    const w = await world();
    const env = envFor(w.root.publicRaw);
    const request = await signedRequest({ key: w.root });
    request.headers.set("x-pointer-subject", "");
    const result = await authenticate(request, env, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ERROR_CODES.badRequest);
  });

  it(
    "rejects a subject claim that differs from the leaf certificate",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const request = await signedRequest({
        key: w.agent1.keys,
        chain: w.agent1.chain,
        subject: "alice/someone-else",
        signWith: w.agent1.keys,
      });
      const result = await authenticate(request, envFor(w.root.publicRaw), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
    },
  );

  it(
    "rejects a request signed by a key that does not own the certificate",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const impostor = await generateKeyPair();
      const request = await signedRequest({
        chain: w.agent1.chain,
        signWith: impostor,
      });
      expect(
        (await authenticate(request, envFor(w.root.publicRaw), NOW)).ok,
      ).toBe(false);
    },
  );

  it("rejects malformed scope headers", { tags: ["unit"] }, async () => {
    const w = await world();
    const env = envFor(w.root.publicRaw);
    const request = await signedRequest({
      key: w.agent1.keys,
      chain: w.agent1.chain,
      signWith: w.agent1.keys,
    });
    request.headers.set("x-pointer-scope", "not-json");
    const invalidJson = await authenticate(request, env, NOW);
    expect(invalidJson.ok).toBe(false);

    const arrayScope = await signedRequest({
      key: w.agent1.keys,
      chain: w.agent1.chain,
      signWith: w.agent1.keys,
    });
    arrayScope.headers.set("x-pointer-scope", "[]");
    expect((await authenticate(arrayScope, env, NOW)).ok).toBe(false);

    const unknownKey = await signedRequest({
      key: w.agent1.keys,
      chain: w.agent1.chain,
      signWith: w.agent1.keys,
    });
    unknownKey.headers.set(
      "x-pointer-scope",
      '{"read":true,"write":false,"sub":"x"}',
    );
    expect((await authenticate(unknownKey, env, NOW)).ok).toBe(false);

    const wrongTypes = await signedRequest({
      key: w.agent1.keys,
      chain: w.agent1.chain,
      signWith: w.agent1.keys,
    });
    wrongTypes.headers.set("x-pointer-scope", '{"read":"yes","write":false}');
    expect((await authenticate(wrongTypes, env, NOW)).ok).toBe(false);
  });

  it(
    "rejects a request that tries to widen the certificate scope",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const request = await signedRequest({
        key: w.reader.keys,
        chain: w.reader.chain,
        signWith: w.reader.keys,
        scope: { read: true, write: true },
      });
      const result = await authenticate(request, envFor(w.root.publicRaw), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(ERROR_CODES.forbidden);
    },
  );

  it(
    "narrows the effective scope when the client asks for less",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const request = await signedRequest({
        key: w.agent1.keys,
        chain: w.agent1.chain,
        signWith: w.agent1.keys,
        scope: { read: true, write: false },
      });
      const result = await authenticate(request, envFor(w.root.publicRaw), NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.auth.scope).toEqual({
          read: true,
          write: false,
          sub: "alice/agent-1",
        });
      }
    },
  );

  it(
    "requires a subject header for certificate-backed requests",
    { tags: ["unit"] },
    async () => {
      const w = await world();
      const request = await signedRequest({
        key: w.agent1.keys,
        chain: w.agent1.chain,
        signWith: w.agent1.keys,
      });
      request.headers.set("x-pointer-subject", "");
      const result = await authenticate(request, envFor(w.root.publicRaw), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/required/);
    },
  );
});

describe("state machine", () => {
  const op = (overrides: Partial<OpRequest> = {}): OpRequest => ({
    op: "write",
    auth: authContext(),
    value: "v",
    expectedVersion: 0,
    ...overrides,
  });

  it(
    "compares and swaps using the version, so ABA writes are rejected",
    { tags: ["unit"] },
    () => {
      const nonces = new Map<string, number>();
      const first = execute(EMPTY_POINTER, nonces, op({ value: "A" }), NOW);
      expect(first.result.ok).toBe(true);
      if (!first.result.ok) return;
      expect(first.result.state.version).toBe(1);
      expect(first.result.state.updatedBy).toBe("alice/agent-1");

      const second = execute(
        first.result.state,
        nonces,
        op({ value: "B", expectedVersion: 1 }),
        NOW,
      );
      expect(second.result.ok).toBe(true);

      const stale = execute(
        second.result.ok ? second.result.state : EMPTY_POINTER,
        nonces,
        op({ value: "A", expectedVersion: 1 }),
        NOW,
      );
      expect(stale.result.ok).toBe(false);
      if (!stale.result.ok) {
        expect(stale.result.code).toBe(ERROR_CODES.preconditionFailed);
        expect(stale.result.state?.version).toBe(2);
      }
    },
  );

  it("rejects a replayed nonce", { tags: ["unit"] }, () => {
    const nonces = new Map<string, number>();
    const request = {
      op: "read" as const,
      auth: authContext({ nonce: "replay-nonce-0001" }),
    };
    const first = execute(EMPTY_POINTER, nonces, request, NOW);
    expect(first.result.ok).toBe(true);
    const playback = new Map(nonces);
    playback.set(first.nonce.value, first.nonce.expiresAt);
    const second = execute(EMPTY_POINTER, playback, request, NOW);
    expect(second.result.ok).toBe(false);
    if (!second.result.ok)
      expect(second.result.code).toBe(ERROR_CODES.replayed);
  });

  it("enforces read and write scopes", { tags: ["unit"] }, () => {
    const readOnly = execute(
      EMPTY_POINTER,
      new Map(),
      {
        op: "write",
        auth: authContext({ scope: { read: true, write: false } }),
        value: "x",
      },
      NOW,
    );
    expect(readOnly.result.ok).toBe(false);
    if (!readOnly.result.ok)
      expect(readOnly.result.code).toBe(ERROR_CODES.forbidden);

    const cannotRead = execute(
      EMPTY_POINTER,
      new Map(),
      {
        op: "read",
        auth: authContext({ scope: { read: false, write: true } }),
      },
      NOW,
    );
    expect(cannotRead.result.ok).toBe(false);
    if (!cannotRead.result.ok)
      expect(cannotRead.result.code).toBe(ERROR_CODES.forbidden);

    const read = execute(
      EMPTY_POINTER,
      new Map(),
      { op: "read", auth: authContext() },
      NOW,
    );
    expect(read.result.ok).toBe(true);
  });

  it(
    "requires a string value and a valid expected version",
    { tags: ["unit"] },
    () => {
      const missing = execute(
        EMPTY_POINTER,
        new Map(),
        { op: "write", auth: authContext(), expectedVersion: 0 },
        NOW,
      );
      expect(missing.result.ok).toBe(false);
      if (!missing.result.ok)
        expect(missing.result.code).toBe(ERROR_CODES.badRequest);

      const negative = execute(
        EMPTY_POINTER,
        new Map(),
        op({ expectedVersion: -1 }),
        NOW,
      );
      expect(negative.result.ok).toBe(false);
      if (!negative.result.ok)
        expect(negative.result.code).toBe(ERROR_CODES.badRequest);

      const fractional = execute(
        EMPTY_POINTER,
        new Map(),
        op({ expectedVersion: 1.5 }),
        NOW,
      );
      expect(fractional.result.ok).toBe(false);
    },
  );

  it("enforces the 256-byte UTF-8 limit", { tags: ["unit"] }, () => {
    const ok = execute(
      EMPTY_POINTER,
      new Map(),
      op({ value: "a".repeat(MAX_VALUE_BYTES) }),
      NOW,
    );
    expect(ok.result.ok).toBe(true);
    const tooLong = execute(
      EMPTY_POINTER,
      new Map(),
      op({ value: "中".repeat(MAX_VALUE_BYTES / 3 + 1) }),
      NOW,
    );
    expect(tooLong.result.ok).toBe(false);
    if (!tooLong.result.ok)
      expect(tooLong.result.code).toBe(ERROR_CODES.tooLarge);
  });

  it("defaults the expected version to zero", { tags: ["unit"] }, () => {
    const result = execute(
      EMPTY_POINTER,
      new Map(),
      { op: "write", auth: authContext(), value: "first" },
      NOW,
    );
    expect(result.result.ok).toBe(true);
    if (result.result.ok) expect(result.result.state.version).toBe(1);
  });

  it(
    "returns idempotency metadata for successful writes",
    { tags: ["unit"] },
    () => {
      const outcome = execute(
        EMPTY_POINTER,
        new Map(),
        op({ idempotencyKey: "key-1", fingerprint: "fp" }),
        NOW,
      );
      expect(outcome.result.ok).toBe(true);
      expect(outcome.idempotency?.key).toBe("key-1");
      expect(outcome.idempotency?.expiresAt).toBe(NOW + 600);

      const withoutKey = execute(EMPTY_POINTER, new Map(), op(), NOW);
      expect(withoutKey.idempotency).toBeUndefined();
    },
  );
});
