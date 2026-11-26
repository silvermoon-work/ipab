import { CID } from "multiformats/cid";
import {
  pointerSigningMessage,
  type PointerProof,
  type RootPointerState,
} from "@ipab/bundle/pointer/pointers";
import {
  importPublicKeyRaw,
  randomBytes,
  sha256Hex,
  toBase64Url,
  verifyEd25519,
} from "@ipab/bundle/pointer/crypto";
import { verifyCertificateChain } from "@ipab/bundle/pointer/certificates";

/** Explicit in-memory NEW API contract port for client tests, not the production Worker. */
export function pointersContract(origin: string, apiKeyHash: string) {
  const states = new Map<
    string,
    { owner: string; root: string; revision: bigint }
  >();
  const nonces = new Map<string, Set<string>>();
  const operations = new Map<
    string,
    { fingerprint: string; response: Response }
  >();
  const json = (
    value: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(value), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      },
    });
  const error = (status: number, code: string, details?: RootPointerState) =>
    json(
      { error: { code, message: code, ...(details ? { details } : {}) } },
      status,
      details ? { etag: `"${details.revision}"` } : {},
    );
  const current = (state: {
    root: string;
    revision: bigint;
  }): RootPointerState => ({
    root: state.root,
    revision: state.revision.toString(),
  });
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== origin || url.search)
        return error(401, "unauthorized");
      const create =
        request.method === "POST" && url.pathname === "/v1/pointers/";
      const id = create
        ? ""
        : /^\/v1\/pointers\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname)?.[1];
      if (
        id === undefined ||
        (!create && !["GET", "PUT"].includes(request.method))
      )
        return error(404, "not_found");
      const existing = create ? undefined : states.get(id);
      if (!create && !existing) return error(404, "not_found");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 16 * 1024) return error(413, "value_too_large");
      let body: Record<string, unknown> = {};
      if (bytes.length) {
        try {
          const parsed: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return error(400, "bad_request");
          body = parsed as Record<string, unknown>;
        } catch {
          return error(400, "bad_request");
        }
      }
      if (
        Object.keys(body).some(
          (key) => !(create ? ["owner", "root"] : ["root"]).includes(key),
        )
      )
        return error(400, "bad_request");
      if (request.method !== "GET") {
        if (typeof body.root !== "string" || body.root.length > 256)
          return error(400, "bad_request");
        try {
          if (CID.parse(body.root).toV1().toString() !== body.root)
            return error(400, "bad_request");
        } catch {
          return error(400, "bad_request");
        }
      }
      const subject = request.headers.get("x-pointer-subject") ?? "";
      const timestamp = Number(request.headers.get("x-pointer-timestamp"));
      const nonce = request.headers.get("x-pointer-nonce") ?? "";
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      const ifMatch = request.headers.get("if-match") ?? "";
      if (
        !Number.isInteger(timestamp) ||
        Math.abs(Date.now() / 1000 - timestamp) > 60 ||
        !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)
      )
        return error(401, "unauthorized");
      if (
        request.method !== "GET" &&
        !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)
      )
        return error(400, "bad_request");
      let publicKey: string;
      if (create) {
        if (
          typeof body.owner !== "string" ||
          subject !== body.owner ||
          (await sha256Hex(request.headers.get("x-api-key") ?? "")) !==
            apiKeyHash
        )
          return error(401, "unauthorized");
        publicKey = body.owner;
        if (request.headers.has("x-pointer-cert"))
          return error(403, "forbidden");
      } else {
        if (request.headers.has("x-api-key")) return error(400, "bad_request");
        publicKey = existing!.owner;
        const encoded = request.headers.get("x-pointer-cert");
        if (encoded) {
          const cert = await verifyCertificateChain(
            [encoded],
            await importPublicKeyRaw(existing!.owner),
            Math.floor(Date.now() / 1000),
            0,
          );
          if (
            !cert.ok ||
            cert.leaf.aud !== `${origin}/v1/pointers/${id}` ||
            cert.leaf.pub !== subject ||
            cert.leaf.ca ||
            !(request.method === "GET" ? cert.scope.read : cert.scope.write)
          )
            return error(403, "forbidden");
          publicKey = cert.leaf.pub;
        } else if (subject !== publicKey) return error(401, "unauthorized");
      }
      const signature = /^Ed25519 ([A-Za-z0-9_-]+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      const proof: PointerProof = {
        origin,
        id,
        method: request.method,
        path: url.pathname,
        bodySha256: await sha256Hex(bytes),
        ifMatch,
        idempotencyKey,
        timestamp,
        nonce,
        subject,
      };
      if (
        !signature ||
        !(await verifyEd25519(
          await importPublicKeyRaw(publicKey),
          signature,
          pointerSigningMessage(proof),
        ))
      )
        return error(401, "unauthorized");
      const scope = create ? "create" : id;
      const used = nonces.get(scope) ?? new Set<string>();
      if (used.has(nonce)) return error(401, "replayed");
      used.add(nonce);
      nonces.set(scope, used);
      if (request.method === "GET") {
        const value = current(existing!);
        return json(value, 200, { etag: `"${value.revision}"` });
      }
      const operation = `${request.method}:${id}:${publicKey}:${idempotencyKey}`;
      const fingerprint = await sha256Hex(`${proof.bodySha256}:${ifMatch}`);
      const previous = operations.get(operation);
      if (previous)
        return previous.fingerprint === fingerprint
          ? previous.response.clone()
          : error(409, "idempotency_conflict");
      if (create) {
        const allocated = toBase64Url(randomBytes(18));
        states.set(allocated, {
          owner: publicKey,
          root: body.root as string,
          revision: 1n,
        });
        const response = json({ id: allocated }, 201, {
          location: `/v1/pointers/${allocated}`,
        });
        operations.set(operation, { fingerprint, response: response.clone() });
        return response;
      }
      const match = /^"([1-9]\d*)"$/.exec(ifMatch);
      if (!match)
        return error(
          ifMatch ? 400 : 428,
          ifMatch ? "bad_request" : "precondition_required",
        );
      if (existing!.revision.toString() !== match[1])
        return error(412, "precondition_failed", current(existing!));
      existing!.root = body.root as string;
      existing!.revision++;
      const value = current(existing!);
      const response = json(value, 200, { etag: `"${value.revision}"` });
      operations.set(operation, { fingerprint, response: response.clone() });
      return response;
    },
  };
}
