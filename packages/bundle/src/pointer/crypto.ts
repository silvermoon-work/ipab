/**
 * Ed25519 / SHA-256 helpers built only on WebCrypto, so the same code runs in
 * Cloudflare Workers and in Node >= 20 (used by the CLI and the tests).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(data));
}

// --------------------------------------------------------------------------
// Ed25519
// --------------------------------------------------------------------------

export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** base64url raw 32-byte public key. Safe to publish. */
  publicRaw: string;
  /** base64url PKCS#8 private key. Never leaves the signer. */
  privatePkcs8: string;
}

/**
 * The Workers, Node and DOM type definitions disagree about Ed25519 support in
 * `SubtleCrypto`. One narrow local view keeps every call site free of casts.
 */
interface SubtleEd25519 {
  generateKey(
    algorithm: { name: string },
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKeyPair>;
  exportKey(format: string, key: CryptoKey): Promise<ArrayBuffer>;
  importKey(
    format: string,
    data: Uint8Array,
    algorithm: { name: string },
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKey>;
  sign(
    algorithm: { name: string },
    key: CryptoKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: { name: string },
    key: CryptoKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

const subtle = crypto.subtle as unknown as SubtleEd25519;

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(
    await subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicRaw: toBase64Url(raw),
    privatePkcs8: toBase64Url(pkcs8),
  };
}

export async function importPublicKeyRaw(
  raw: string | Uint8Array,
): Promise<CryptoKey> {
  const bytes = typeof raw === "string" ? fromBase64Url(raw) : raw;
  if (bytes.byteLength !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  return subtle.importKey("raw", bytes, { name: "Ed25519" }, true, ["verify"]);
}

export async function importPrivateKeyPkcs8(pkcs8: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(pkcs8);
  return subtle.importKey(
    "pkcs8",
    new Uint8Array(bytes),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

export async function signEd25519(
  privateKey: CryptoKey,
  message: string,
): Promise<string> {
  const sig = await subtle.sign({ name: "Ed25519" }, privateKey, utf8(message));
  return toBase64Url(new Uint8Array(sig));
}

export async function verifyEd25519(
  publicKey: CryptoKey,
  signature: string,
  message: string,
): Promise<boolean> {
  try {
    const sig = fromBase64Url(signature);
    if (sig.byteLength !== 64) return false;
    return await subtle.verify(
      { name: "Ed25519" },
      publicKey,
      sig,
      utf8(message),
    );
  } catch {
    return false;
  }
}

/** Stable id for a public key: base64url(SHA-256(raw public key)). */
export async function keyId(publicRaw: string): Promise<string> {
  return toBase64Url(await sha256(fromBase64Url(publicRaw)));
}

// --------------------------------------------------------------------------
// Trust-anchor parsing
// --------------------------------------------------------------------------

const SPKI_PREFIX = "302a300506032b6570032100"; // DER: Ed25519 SubjectPublicKeyInfo header

const anchorCache = new Map<
  string,
  { publicKey: CryptoKey; publicRaw: string }
>();

/**
 * Accepts the pinned anchor as
 *  - base64url / base64 raw 32-byte Ed25519 public key,
 *  - a `-----BEGIN PUBLIC KEY-----` SPKI PEM block,
 *  - a JSON Web Key.
 *
 * Parsing + key import is cached per input, so it happens once per isolate.
 */
export async function loadTrustAnchor(
  input: string,
): Promise<{ publicKey: CryptoKey; publicRaw: string }> {
  const cached = anchorCache.get(input);
  if (cached) return cached;
  const parsed = await parseTrustAnchor(input);
  anchorCache.set(input, parsed);
  return parsed;
}

async function parseTrustAnchor(
  input: string,
): Promise<{ publicKey: CryptoKey; publicRaw: string }> {
  const text = input.trim();
  let raw: Uint8Array;

  if (text.startsWith("{")) {
    const jwk = JSON.parse(text) as JsonWebKey;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
      throw new Error("JWK must be an Ed25519 OKP public key");
    }
    raw = fromBase64Url(jwk.x);
  } else if (text.includes("BEGIN PUBLIC KEY")) {
    const body = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    const hex = toHex(der);
    if (
      !hex.startsWith(SPKI_PREFIX) ||
      der.byteLength !== SPKI_PREFIX.length / 2 + 32
    ) {
      throw new Error("PEM is not an Ed25519 SubjectPublicKeyInfo");
    }
    raw = der.slice(der.byteLength - 32);
  } else {
    raw = fromBase64Url(text.replace(/\+/g, "-").replace(/\//g, "_"));
  }

  if (raw.byteLength !== 32)
    throw new Error("trust anchor must be a 32-byte Ed25519 key");
  const publicKey = await importPublicKeyRaw(raw);
  return { publicKey, publicRaw: toBase64Url(raw) };
}

export function publicKeyToPem(publicRaw: string): string {
  const der = new Uint8Array([
    ...fromHex(SPKI_PREFIX),
    ...fromBase64Url(publicRaw),
  ]);
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

export function decodeText(bytes: ArrayBuffer | Uint8Array): string {
  return decoder.decode(bytes);
}
