import { DurableObject } from "cloudflare:workers";
import {
  boundedText,
  decodeScopeCertificate,
  scopeSigningMessage,
  uniqueId,
  valueCid,
  verifyScopeCertificate,
  type Json,
  type ScopeProof,
  type Variable,
} from "@ipab/bundle/pointer/scope";
import { importPublicKeyRaw, sha256Hex, verifyEd25519 } from "./crypto.ts";
import {
  apiFailure,
  isCanonicalPublicKey,
  ServiceError,
  type ApiFailure,
} from "./protocol.ts";
import { consumeNonce } from "./state.ts";

export interface ScopeWire {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
export async function scopeWire(request: Request): Promise<ScopeWire> {
  if ((request.headers.get("x-ipab-certificate")?.length ?? 0) > 8192)
    throw new ServiceError(413, "too_large", "certificate too large");
  if (new URL(request.url).search)
    throw new ServiceError(400, "bad_request", "no query parameters");
  let size = 0;
  for (const [k, v] of request.headers)
    size += new TextEncoder().encode(k + v).length;
  if (size > 16384)
    throw new ServiceError(413, "too_large", "headers too large");
  return {
    method: request.method,
    path: new URL(request.url).pathname,
    headers: Object.fromEntries(request.headers),
    body: await boundedText(request),
  };
}
export interface ScopeAuth {
  subject: string;
  nonce: string;
  key: string;
  fingerprint: string;
  ifMatch: string;
}
export async function scopeAuthenticate(
  wire: ScopeWire,
  owner: string,
  service: string,
  scopeId: string,
  variableId: string,
  ownerOnly: boolean,
): Promise<ScopeAuth> {
  const h = wire.headers;
  const timestamp = Number(h["x-ipab-timestamp"]);
  const subject = h["x-ipab-subject"] ?? "";
  const nonce = h["x-ipab-nonce"] ?? "";
  const key = h["idempotency-key"] ?? "";
  if (
    !/^(0|[1-9]\d*)$/.test(h["x-ipab-timestamp"] ?? "") ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(timestamp - Math.floor(Date.now() / 1000)) > 60
  )
    throw new ServiceError(
      401,
      "stale_proof",
      "proof timestamp must be within 60 seconds",
    );
  if (
    !isCanonicalPublicKey(subject) ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(nonce) ||
    !/^[A-Za-z0-9._-]{16,128}$/.test(key)
  )
    throw new ServiceError(
      400,
      "bad_proof",
      "canonical subject, random nonce and idempotency key required",
    );
  if (subject !== owner) {
    if (ownerOnly)
      throw new ServiceError(
        403,
        "owner_required",
        "only owner can manage resources",
      );
    try {
      await verifyScopeCertificate(
        decodeScopeCertificate(h["x-ipab-certificate"] ?? ""),
        owner,
        service,
        scopeId,
        variableId,
        subject,
      );
    } catch (cause) {
      if (cause instanceof ServiceError) throw cause;
      throw new ServiceError(403, "cert_invalid", "invalid certificate");
    }
  }
  const proof: ScopeProof = {
    service,
    scopeId,
    variableId,
    path: wire.path,
    method: wire.method,
    subject,
    nonce,
    timestamp,
    idempotencyKey: key,
    bodySha256: await sha256Hex(wire.body),
    ifMatch: h["if-match"] ?? "",
  };
  const sig = /^Ed25519 ([A-Za-z0-9_-]{86})$/.exec(h.authorization ?? "")?.[1];
  if (
    !sig ||
    !(await verifyEd25519(
      await importPublicKeyRaw(subject),
      sig,
      scopeSigningMessage(proof),
    ))
  )
    throw new ServiceError(
      401,
      "bad_signature",
      "invalid subject possession proof",
    );
  return {
    subject,
    nonce,
    key,
    ifMatch: proof.ifMatch,
    fingerprint: await sha256Hex(
      JSON.stringify([
        service,
        scopeId,
        variableId,
        wire.method,
        wire.path,
        subject,
        proof.bodySha256,
        proof.ifMatch,
      ]),
    ),
  };
}
interface Retry {
  fingerprint: string;
  result: ScopeResult;
  expiresAt: number | null;
}
export interface ScopeResult {
  status: number;
  body: unknown;
}
export class ScopeObject extends DurableObject<Env> {
  async configure(owner: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<string>("owner");
      if (existing && existing !== owner)
        throw new Error("scope owner conflict");
      if (!existing) await txn.put("owner", owner);
    });
  }
  async handle(
    wire: ScopeWire,
    scopeId: string,
    variableId: string,
    action: string,
  ): Promise<{ status: number; json: string } | ApiFailure> {
    const result = await this.#operate(wire, scopeId, variableId, action);
    return "error" in result
      ? result
      : { status: result.status, json: JSON.stringify(result.body) };
  }
  async #operate(
    wire: ScopeWire,
    scopeId: string,
    variableId: string,
    action: string,
  ): Promise<ScopeResult | ApiFailure> {
    try {
      const owner = await this.ctx.storage.get<string>("owner");
      if (!owner)
        throw new ServiceError(404, "not_found", "scope does not exist");
      if (wire.method === "GET") {
        if (wire.body)
          throw new ServiceError(
            400,
            "bad_request",
            "GET must not have a body",
          );
        if (!variableId) return { status: 200, body: { id: scopeId, owner } };
        const value = await this.ctx.storage.get<Variable>(
          `variable:${variableId}`,
        );
        if (!value)
          throw new ServiceError(404, "not_found", "variable does not exist");
        if (value.status === "deleted")
          throw new ServiceError(410, "deleted", "variable is deleted");
        return { status: 200, body: value };
      }
      const auth = await scopeAuthenticate(
        wire,
        owner,
        this.env.POINTER_SERVICE,
        scopeId,
        variableId,
        wire.method !== "PUT",
      );
      let value: Json | undefined, cid: string | undefined;
      let inputError: ServiceError | undefined;
      try {
        if (wire.method === "PUT" || (wire.method === "POST" && !variableId)) {
          const parsed = JSON.parse(wire.body) as { value: Json } | null;
          if (!parsed || Object.keys(parsed).join() !== "value")
            throw new ServiceError(400, "bad_request", "requires only value");
          value = parsed.value;
          cid = await valueCid(value);
        } else if (wire.body)
          throw new ServiceError(
            400,
            "bad_request",
            "management must not have a body",
          );
      } catch (cause) {
        if (cause instanceof ServiceError) inputError = cause;
        else if (cause instanceof SyntaxError)
          inputError = new ServiceError(400, "bad_request", "invalid JSON");
        else throw cause;
      }
      const retryKey = `retry:${await sha256Hex(JSON.stringify([auth.subject, auth.key]))}`;
      // Scope is the coordination atom: lifecycle, CAS, allocation and retry commit together.
      return await this.ctx.storage.transaction(async (txn) => {
        const nonces = consumeNonce(
          (await txn.get<Record<string, number>>("nonces")) ?? {},
          auth.nonce,
          Math.floor(Date.now() / 1000),
        );
        await txn.put("nonces", nonces);
        try {
          if (inputError) throw inputError;
          const now = Math.floor(Date.now() / 1000);
          const records = await txn.list<{ expiresAt: number | null }>({
            prefix: "retry-meta:",
          });
          for (const [key, record] of records) {
            if (record.expiresAt !== null && record.expiresAt <= now) {
              await txn.delete(key);
              await txn.delete(key.replace("retry-meta:", "retry:"));
              records.delete(key);
            }
          }
          const prior = records.has(retryKey.replace("retry:", "retry-meta:"))
            ? await txn.get<Retry>(retryKey)
            : undefined;
          if (prior) {
            if (prior.fingerprint !== auth.fingerprint)
              return {
                status: 409,
                body: {
                  error: {
                    code: "idempotency_conflict",
                    message: "key already used for a different operation",
                  },
                },
              };
            return prior.result;
          }
          const permanent = wire.method !== "PUT";
          const count = [...records.values()].filter(
            (record) => (record.expiresAt === null) === permanent,
          ).length;
          if (count >= (permanent ? 12288 : 4096))
            throw new ServiceError(
              429,
              "retry_capacity",
              "retry capacity exhausted; live records are never evicted",
            );
          let id = variableId;
          let result: ScopeResult;
          if (wire.method === "POST" && !id) {
            const count = (await txn.get<number>("count")) ?? 0;
            if (count >= 4096)
              throw new ServiceError(
                429,
                "scope_capacity",
                "scope lifetime allocation limit reached",
              );
            do {
              id = uniqueId();
            } while (await txn.get(`variable:${id}`));
            const state: Variable = {
              value: value!,
              cid: cid!,
              status: "writable",
            };
            await txn.put(`variable:${id}`, state);
            await txn.put("count", count + 1);
            result = { status: 201, body: { id, ...state } };
          } else {
            const current = await txn.get<Variable>(`variable:${id}`);
            if (!current)
              throw new ServiceError(
                404,
                "not_found",
                "variable does not exist",
              );
            if (current.status === "deleted")
              throw new ServiceError(410, "deleted", "variable is deleted");
            let next = current;
            if (wire.method === "PUT") {
              if (current.status !== "writable")
                throw new ServiceError(
                  423,
                  "frozen",
                  "variable is irreversibly frozen",
                );
              if (!auth.ifMatch)
                throw new ServiceError(
                  428,
                  "precondition_required",
                  "content CID If-Match required",
                );
              if (auth.ifMatch !== `"${current.cid}"`)
                result = {
                  status: 412,
                  body: {
                    error: {
                      code: "cas_conflict",
                      message: "value CID changed",
                      details: current,
                    },
                  },
                };
              else {
                next = { value: value!, cid: cid!, status: "writable" };
                result = { status: 200, body: next };
              }
            } else if (wire.method === "POST" && action === "freeze") {
              next = { ...current, status: "frozen" };
              result = { status: 200, body: next };
            } else if (wire.method === "DELETE") {
              if (current.status !== "frozen")
                throw new ServiceError(
                  409,
                  "freeze_required",
                  "freeze before delete",
                );
              next = { value: null, cid: current.cid, status: "deleted" };
              result = { status: 200, body: next };
            } else
              throw new ServiceError(
                405,
                "method_not_allowed",
                "unsupported operation",
              );
            await txn.put(`variable:${id}`, next);
          }
          await txn.put(retryKey, {
            fingerprint: auth.fingerprint,
            result,
            expiresAt: permanent ? null : now + 600,
          });
          await txn.put(retryKey.replace("retry:", "retry-meta:"), {
            expiresAt: permanent ? null : now + 600,
          });
          return result;
        } catch (cause) {
          if (cause instanceof ServiceError)
            return {
              status: cause.status,
              body: { error: { code: cause.code, message: cause.message } },
            };
          throw cause;
        }
      });
    } catch (cause) {
      if (cause instanceof ServiceError) return apiFailure(cause);
      if (cause instanceof SyntaxError)
        return apiFailure(new ServiceError(400, "bad_request", "invalid JSON"));
      throw cause;
    }
  }
}
