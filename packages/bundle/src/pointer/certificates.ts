import {
  type Certificate,
  type CertificateBody,
  type DelegatedScope,
  MAX_CHAIN_DEPTH,
  certificateSigningMessage,
  normalizeScope,
  scopeIsSubset,
  subjectMatches,
  subjectPatternIsNarrower,
} from "./protocol.js";
import {
  fromBase64Url,
  importPublicKeyRaw,
  signEd25519,
  verifyEd25519,
} from "./crypto.js";

export type CertificateFailure = {
  ok: false;
  code:
    | "cert_invalid"
    | "cert_chain_invalid"
    | "cert_expired"
    | "cert_not_yet_valid";
  message: string;
  index?: number;
};

export type CertificateSuccess = {
  ok: true;
  /** Leaf certificate: the key that signed the request. */
  leaf: CertificateBody;
  /** Root-anchored chain, leaf first. Empty when the anchor key signed directly. */
  chain: CertificateBody[];
  /** Capabilities actually available to this request. */
  scope: DelegatedScope;
};

export type CertificateResult = CertificateSuccess | CertificateFailure;

export type { Certificate, CertificateBody } from "./protocol.js";

const fail = (
  code: CertificateFailure["code"],
  message: string,
  index?: number,
): CertificateFailure => ({
  ok: false,
  code,
  message,
  ...(index === undefined ? {} : { index }),
});

function parseCertificate(encoded: string): Certificate | null {
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encoded)),
    );
    if (typeof decoded !== "object" || decoded === null) return null;
    const record = decoded as Record<string, unknown>;
    const body = record.body;
    if (typeof body !== "object" || body === null) return null;
    const fields = body as Record<string, unknown>;
    if (
      fields.v !== 1 ||
      (fields.aud !== undefined && typeof fields.aud !== "string") ||
      typeof fields.sub !== "string" ||
      typeof fields.pub !== "string" ||
      typeof fields.iss !== "string" ||
      typeof fields.iss_pub !== "string" ||
      typeof fields.kid !== "string" ||
      typeof fields.cid !== "string" ||
      !Number.isInteger(fields.iat) ||
      !Number.isInteger(fields.exp) ||
      typeof fields.ca !== "boolean" ||
      typeof record.sig !== "string" ||
      typeof fields.scope !== "object" ||
      fields.scope === null
    ) {
      return null;
    }
    const certificate = decoded as Certificate;
    certificate.body.scope = normalizeScope(certificate.body.scope);
    return certificate;
  } catch {
    return null;
  }
}

/**
 * Verifies a certificate chain and returns the leaf's effective scope.
 *
 * Trust rule: the pinned anchor must have issued at least one certificate in
 * the chain. A bare self-signed root certificate is therefore rejected — the
 * anchor *is* the root and never has to be transmitted.
 *
 * Every hop is checked:
 *  - signature by the next certificate (or by the anchor at the root),
 *  - `iss` / `iss_pub` / `kid` continuity between child and parent,
 *  - validity window strictly inside the parent's,
 *  - child scope is a subset of the parent scope,
 *  - parent's `scope.sub` pattern covers the child's subject.
 */
export async function verifyCertificateChain(
  encodedChain: string[],
  anchor: CryptoKey,
  nowSeconds: number,
  clockSkewSeconds: number,
): Promise<CertificateResult> {
  if (encodedChain.length === 0) {
    return fail("cert_chain_invalid", "certificate chain is empty");
  }
  if (encodedChain.length > MAX_CHAIN_DEPTH) {
    return fail(
      "cert_chain_invalid",
      `certificate chain deeper than ${MAX_CHAIN_DEPTH}`,
    );
  }

  const certs = encodedChain.map(parseCertificate);
  const brokenAt = certs.findIndex((c) => c === null);
  if (brokenAt >= 0)
    return fail("cert_invalid", "malformed certificate", brokenAt);

  const leaf = certs[0]!;
  if (leaf.body.ca) {
    return fail("cert_invalid", "the signer's certificate must not be a CA", 0);
  }

  for (let i = 0; i < certs.length; i++) {
    const cert = certs[i]!;
    const b = cert.body;

    if (nowSeconds + clockSkewSeconds < b.iat) {
      return fail("cert_not_yet_valid", `certificate ${i} is not valid yet`, i);
    }
    if (nowSeconds - clockSkewSeconds > b.exp) {
      return fail("cert_expired", `certificate ${i} has expired`, i);
    }
    if (b.exp <= b.iat) {
      return fail(
        "cert_invalid",
        `certificate ${i} has an empty validity window`,
        i,
      );
    }

    // The certificate may only claim a subject its own scope can vouch for.
    // Otherwise a cert for "alice" could carry scope.sub "bob/*" and grant
    // rights in bob's namespace.
    if (!subjectMatches(b.scope.sub, b.sub)) {
      return fail(
        "cert_invalid",
        `certificate ${i} subject falls outside its own scope`,
        i,
      );
    }

    const isLast = i === certs.length - 1;
    const issuerRaw = isLast ? null : certs[i + 1]!.body.pub;
    const issuerKey = isLast
      ? anchor
      : await importPublicKeyRaw(certs[i + 1]!.body.pub);

    if (isLast) {
      // Root hop: signed by the pinned anchor. The anchor has no certificate, so
      // its identity fields are intentionally not trusted or compared.
      const ok = await verifyEd25519(
        issuerKey,
        cert.sig,
        certificateSigningMessage(b),
      );
      if (!ok)
        return fail(
          "cert_invalid",
          `certificate ${i} is not signed by the trust anchor`,
          i,
        );
      continue;
    }

    const parent = certs[i + 1]!.body;
    if (parent.aud !== undefined && b.aud !== parent.aud)
      return fail("cert_chain_invalid", "child changes issuer audience", i);
    if (b.iss !== parent.sub || b.iss_pub !== issuerRaw) {
      return fail(
        "cert_chain_invalid",
        `certificate ${i} issuer does not match certificate ${i + 1}`,
        i,
      );
    }
    if (!parent.ca) {
      return fail(
        "cert_chain_invalid",
        `certificate ${i + 1} is not allowed to issue certificates`,
        i + 1,
      );
    }
    if (
      b.iat < parent.iat - clockSkewSeconds ||
      b.exp > parent.exp + clockSkewSeconds
    ) {
      return fail(
        "cert_chain_invalid",
        `certificate ${i} outlives its issuer`,
        i,
      );
    }

    // Parent scope must cover the child's subject and every capability.
    if (!subjectMatches(parent.scope.sub, b.sub)) {
      return fail(
        "cert_chain_invalid",
        `issuer ${i + 1} may not issue for subject "${b.sub}"`,
        i,
      );
    }
    if (!scopeIsSubset(b.scope, parent.scope)) {
      return fail(
        "cert_chain_invalid",
        `certificate ${i} exceeds the scope of its issuer`,
        i,
      );
    }

    const ok = await verifyEd25519(
      issuerKey,
      cert.sig,
      certificateSigningMessage(b),
    );
    if (!ok)
      return fail("cert_invalid", `certificate ${i} signature is invalid`, i);
  }

  return {
    ok: true,
    leaf: certs[0]!.body,
    chain: certs.map((c) => c!.body),
    scope: certs[0]!.body.scope,
  };
}

export async function issueCertificate(
  body: CertificateBody,
  issuerPrivateKey: CryptoKey,
): Promise<Certificate> {
  const sig = await signEd25519(
    issuerPrivateKey,
    certificateSigningMessage(body),
  );
  return { body, sig };
}

/** Serializes a certificate for the `X-Pointer-Cert` header. */
export function encodeCertificate(cert: Certificate): string {
  const json = JSON.stringify(cert);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Applied to the leaf scope when the client sends `X-Pointer-Scope`. */
export function narrowScope(
  leaf: DelegatedScope,
  requested: DelegatedScope | null,
): DelegatedScope | null {
  if (!requested) return leaf;
  // The identity pattern is not client-selectable: inherit the leaf's own
  // pattern so a request that only narrows read/write stays a subset.
  const candidate: DelegatedScope = {
    read: requested.read,
    write: requested.write,
    ...(leaf.sub ? { sub: leaf.sub } : {}),
  };
  if (!scopeIsSubset(candidate, leaf)) return null;
  return candidate;
}

export { subjectPatternIsNarrower };
