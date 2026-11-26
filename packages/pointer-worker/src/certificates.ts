import {
  certificateSigningMessage,
  isCanonicalPublicKey,
  MAX_CERT_BYTES,
  ServiceError,
  type Certificate,
  type CertificateBody,
  type DelegatedScope,
  scopeIsSubset,
} from "./protocol.ts";
import {
  fromBase64Url,
  toBase64Url,
  utf8,
  signEd25519,
  verifyEd25519,
} from "./crypto.ts";

export async function issueCertificate(
  body: CertificateBody,
  ownerPrivateKey: CryptoKey,
): Promise<Certificate> {
  return {
    body,
    sig: await signEd25519(ownerPrivateKey, certificateSigningMessage(body)),
  };
}
export function encodeCertificate(cert: Certificate): string {
  return toBase64Url(utf8(JSON.stringify(cert)));
}
export async function verifyMemberCertificate(
  encoded: string,
  anchor: CryptoKey,
  owner: string,
  service: string,
  pointerId: string,
  now: number,
): Promise<CertificateBody> {
  if (encoded.length > MAX_CERT_BYTES)
    throw new ServiceError(413, "too_large", "certificate too large");
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(encoded)),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    const record = parsed as Record<string, unknown>;
    if (
      !record.body ||
      typeof record.body !== "object" ||
      Array.isArray(record.body)
    )
      throw new Error();
    const fields = record.body as Record<string, unknown>;
    if (fields.v !== 2) throw new Error();
    const cert = parsed as Certificate;
    const body = cert.body;
    if (
      Object.keys(cert).sort().join(",") !== "body,sig" ||
      Object.keys(body).sort().join(",") !==
        "cid,exp,iat,member,owner,pointerId,service,v" ||
      body.owner !== owner ||
      body.service !== service ||
      body.pointerId !== pointerId ||
      !isCanonicalPublicKey(body.member) ||
      typeof body.cid !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(body.cid) ||
      !Number.isSafeInteger(body.iat) ||
      !Number.isSafeInteger(body.exp) ||
      body.exp <= body.iat ||
      now < body.iat ||
      now >= body.exp ||
      typeof cert.sig !== "string" ||
      !(await verifyEd25519(anchor, cert.sig, certificateSigningMessage(body)))
    )
      throw new Error();
    return body;
  } catch {
    throw new ServiceError(
      403,
      "cert_invalid",
      "requires a valid owner-issued leaf certificate for this service and pointer",
    );
  }
}
export function narrowScope(
  leaf: DelegatedScope,
  requested: DelegatedScope | null,
): DelegatedScope | null {
  if (!requested) return leaf;
  const candidate = {
    read: requested.read,
    write: requested.write,
    ...(leaf.sub ? { sub: leaf.sub } : {}),
  };
  return scopeIsSubset(candidate, leaf) ? candidate : null;
}
