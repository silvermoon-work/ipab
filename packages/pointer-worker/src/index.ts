import { PointerObject } from "./pointer-object.ts";
import { RegistryObject } from "./registry-object.ts";
import { authenticate, boundedRequest } from "./verify.ts";
import {
  canonicalService,
  isCanonicalPublicKey,
  parseBody,
  POINTER_ID_PATTERN,
  PROTOCOL_VERSION,
  ServiceError,
} from "./protocol.ts";
import { fromHex, sha256 } from "./crypto.ts";

export { PointerObject, RegistryObject };
export type Env = globalThis.Env;

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
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
  const actual = await sha256(key);
  const expected = fromHex(env.POINTER_API_KEY_SHA256!);
  // Workers timingSafeEqual compares digests without data-dependent timing.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  return subtle.timingSafeEqual(actual, expected);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const cors: Record<string, string> =
      env.ALLOWED_ORIGIN && request.headers.get("origin") === env.ALLOWED_ORIGIN
        ? {
            "access-control-allow-origin": env.ALLOWED_ORIGIN,
            "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
            "access-control-allow-headers":
              "authorization, content-type, if-match, idempotency-key, x-api-key, x-pointer-cert, x-pointer-subject, x-pointer-timestamp, x-pointer-nonce",
            "access-control-expose-headers": "etag",
            vary: "origin",
          }
        : {};
    let response: Response;
    try {
      if (request.method === "OPTIONS")
        response = new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      else if (path === "/_health" && request.method === "GET")
        response = json({ ok: true, protocol: PROTOCOL_VERSION });
      else {
        canonicalService(env.POINTER_SERVICE);
        if (path === "/v1/pointers/") {
          if (request.method !== "POST")
            throw new ServiceError(405, "method_not_allowed", "use POST");
          if (!(await apiKeyValid(request, env)))
            throw new ServiceError(
              401,
              "unauthorized",
              "valid service API key required",
            );
          const wire = await boundedRequest(request);
          let body: Record<string, unknown>;
          try {
            body = parseBody(wire.body, true);
          } catch (err) {
            if (err instanceof ServiceError) throw err;
            throw new ServiceError(400, "bad_request", String(err));
          }
          const owner = body.owner as string,
            root = body.root as string;
          const auth = await authenticate(
            wire,
            owner,
            env.POINTER_SERVICE,
            "",
            Math.floor(Date.now() / 1000),
          );
          const registry = env.REGISTRY.get(
            env.REGISTRY.idFromName("registry-v2"),
          );
          const config = await registry.reserve(owner, root, auth);
          if ("error" in config)
            throw new ServiceError(
              config.error.status,
              config.error.code,
              config.error.message,
            );
          const pointer = env.POINTER.get(
            env.POINTER.idFromName(`pointer-v2:${config.id}`),
          );
          // Do not remove a reservation on failure: a fresh proof with the same
          // idempotency key recovers configuration even after an ambiguous commit.
          await pointer.configure(config);
          await registry.complete(config);
          response = json({ id: config.id }, 201, {
            location: `/v1/pointers/${config.id}`,
          });
        } else {
          const id = /^\/v1\/pointers\/([^/]+)$/.exec(path)?.[1];
          if (!id || !POINTER_ID_PATTERN.test(id))
            throw new ServiceError(404, "not_found", "route does not exist");
          if (!["GET", "PUT"].includes(request.method))
            throw new ServiceError(405, "method_not_allowed", "use GET or PUT");
          const pointer = env.POINTER.get(
            env.POINTER.idFromName(`pointer-v2:${id}`),
          );
          const result = await pointer.handle(await boundedRequest(request));
          if ("error" in result)
            throw new ServiceError(
              result.error.status,
              result.error.code,
              result.error.message,
            );
          if (result.status === 409)
            response = json(
              {
                error: {
                  code: "idempotency_conflict",
                  message: "Idempotency-Key was used for a different write",
                },
              },
              409,
            );
          else
            response = json(
              result.status === 412
                ? {
                    error: {
                      code: "precondition_failed",
                      message: "pointer revision has changed",
                      details: result.state,
                    },
                  }
                : result.state,
              result.status,
              { etag: `"${result.state.revision}"` },
            );
        }
      }
    } catch (err) {
      if (err instanceof ServiceError)
        response = json(
          { error: { code: err.code, message: err.message } },
          err.status,
        );
      else {
        console.error(
          JSON.stringify({
            event: "pointer_service_failure",
            message: "configuration or storage failure",
          }),
        );
        response = json(
          { error: { code: "internal", message: "service unavailable" } },
          500,
        );
      }
    }
    for (const [key, value] of Object.entries(cors))
      response.headers.set(key, value);
    return response;
  },
} satisfies ExportedHandler<Env>;
