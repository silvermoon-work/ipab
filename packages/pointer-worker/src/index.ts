import { ScopeObject, scopeAuthenticate, scopeWire } from "./scope-object.ts";
import { ScopeRegistry } from "./scope-registry.ts";
import { PointerObject } from "./pointer-object.ts";
import { RegistryObject } from "./registry-object.ts";
import {
  canonicalService,
  isCanonicalPublicKey,
  POINTER_ID_PATTERN,
  ServiceError,
} from "./protocol.ts";
import { fromHex, sha256 } from "./crypto.ts";

export { ScopeObject, ScopeRegistry, PointerObject, RegistryObject };
export type Env = globalThis.Env;
function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
async function apiKeyValid(request: Request, env: Env): Promise<boolean> {
  const key = request.headers.get("x-api-key") ?? "";
  if (
    !isCanonicalPublicKey(key) ||
    !/^[a-f0-9]{64}$/.test(env.POINTER_API_KEY_SHA256 ?? "")
  )
    return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  return subtle.timingSafeEqual(
    await sha256(key),
    fromHex(env.POINTER_API_KEY_SHA256!),
  );
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/_health" && request.method === "GET")
        return json({ ok: true, protocol: "scope-variable/1" });
      canonicalService(env.POINTER_SERVICE);
      if (request.method === "OPTIONS")
        response = new Response(null, { status: 204 });
      else if (path === "/v1/scopes" && request.method === "POST") {
        if (!(await apiKeyValid(request, env)))
          throw new ServiceError(
            401,
            "unauthorized",
            "creation API key required",
          );
        const wire = await scopeWire(request);
        const body = JSON.parse(wire.body) as { owner: string } | null;
        if (
          !body ||
          Object.keys(body).join() !== "owner" ||
          !isCanonicalPublicKey(body.owner)
        )
          throw new ServiceError(
            400,
            "bad_request",
            "canonical owner required",
          );
        const auth = await scopeAuthenticate(
          wire,
          body.owner,
          env.POINTER_SERVICE,
          "",
          "",
          true,
        );
        const registry = env.SCOPE_REGISTRY.getByName(
          `scope-registry:${body.owner}`,
        );
        const allocation = await registry.reserve(body.owner, auth);
        if ("error" in allocation)
          throw new ServiceError(
            allocation.error.status,
            allocation.error.code,
            allocation.error.message,
          );
        await env.SCOPE.getByName(`scope:${allocation.id}`).configure(
          allocation.owner,
        );
        response = json(allocation, 201);
      } else {
        const match = /^\/v1\/([^/]+)(?:\/([^/]+))?(?:\/(freeze))?$/.exec(path);
        const scopeId = match?.[1] ?? "",
          variableId = match?.[2] ?? "",
          action = match?.[3] ?? "";
        if (
          !POINTER_ID_PATTERN.test(scopeId) ||
          (variableId && !POINTER_ID_PATTERN.test(variableId))
        )
          throw new ServiceError(
            404,
            "not_found",
            "route does not exist; old pointer protocol is unsupported",
          );
        if (
          !["GET", "POST", "PUT", "DELETE"].includes(request.method) ||
          (action && request.method !== "POST") ||
          (action && !variableId)
        )
          throw new ServiceError(405, "method_not_allowed", "invalid method");
        const result = await env.SCOPE.getByName(`scope:${scopeId}`).handle(
          await scopeWire(request),
          scopeId,
          variableId,
          action,
        );
        if ("error" in result)
          throw new ServiceError(
            result.error.status,
            result.error.code,
            result.error.message,
          );
        response = json(JSON.parse(result.json) as unknown, result.status);
      }
    } catch (cause) {
      if (cause instanceof ServiceError)
        response = json(
          { error: { code: cause.code, message: cause.message } },
          cause.status,
        );
      else if (cause instanceof SyntaxError)
        response = json(
          { error: { code: "bad_request", message: "invalid JSON" } },
          400,
        );
      else {
        console.error(
          JSON.stringify({
            event: "scope_service_failure",
            message: "storage or configuration failure",
          }),
        );
        response = json(
          { error: { code: "internal", message: "service unavailable" } },
          500,
        );
      }
    }
    if (
      env.ALLOWED_ORIGIN &&
      request.headers.get("origin") === env.ALLOWED_ORIGIN
    ) {
      response.headers.set("access-control-allow-origin", env.ALLOWED_ORIGIN);
      response.headers.set(
        "access-control-allow-methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      response.headers.set(
        "access-control-allow-headers",
        "authorization, content-type, if-match, idempotency-key, x-api-key, x-ipab-certificate, x-ipab-subject, x-ipab-timestamp, x-ipab-nonce",
      );
      response.headers.set("vary", "origin");
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
