import {
  ERROR_CODES,
  MAX_CHAIN_DEPTH,
  MAX_VALUE_BYTES,
  PROTOCOL_VERSION,
  isValidVariableName,
  type ErrorBody,
  type PointerConfig,
  type PointerState,
} from "./protocol.ts";
import { authenticate } from "./verify.ts";
import type { OpRequest, OpResult } from "./state.ts";
import { PointerObject } from "./pointer-object.ts";
import { RegistryObject } from "./registry-object.ts";
import { loadTrustAnchor } from "./crypto.ts";

export { PointerObject, RegistryObject };

export interface Env {
  POINTER: DurableObjectNamespace<PointerObject>;
  REGISTRY: DurableObjectNamespace<RegistryObject>;
  /** Pinned Ed25519 key allowed to create/delete/rotate variables. */
  POINTER_ADMIN_PUBLIC_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

const REGISTRY_NAME = "registry";
const VARIABLE_PREFIX = "var:";
const ADMIN_PREFIX = "/_admin/v1/variables";

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

type PointerStub = ReturnType<Env["POINTER"]["get"]>;
type RegistryStub = ReturnType<Env["REGISTRY"]["get"]>;

function corsHeaders(env: Env, request: Request): Record<string, string> {
  if (!env.ALLOWED_ORIGIN) return {};
  const origin = request.headers.get("origin");
  if (!origin || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, if-match, idempotency-key, x-pointer-cert, x-pointer-scope, x-pointer-subject, x-pointer-timestamp, x-pointer-nonce, x-pointer-audience",
    "access-control-expose-headers": "etag",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function json(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function error(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  const body: ErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return json(body, status, extraHeaders);
}

const STATUS_BY_CODE: Record<string, number> = {
  [ERROR_CODES.forbidden]: 403,
  [ERROR_CODES.replayed]: 401,
  [ERROR_CODES.preconditionFailed]: 412,
  [ERROR_CODES.preconditionRequired]: 428,
  [ERROR_CODES.tooLarge]: 413,
  [ERROR_CODES.badRequest]: 400,
  [ERROR_CODES.idempotencyConflict]: 409,
  [ERROR_CODES.conflict]: 409,
  [ERROR_CODES.unknownPointer]: 404,
};

function pointerBody(state: PointerState) {
  return {
    value: state.value,
    version: state.version,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
}

function etagFor(version: number): string {
  return `"${version}"`;
}

function shape(
  state: PointerState,
  extra: Record<string, unknown> = {},
): Response {
  return json({ ...pointerBody(state), ...extra }, 200, {
    etag: etagFor(state.version),
  });
}

/** Parses `If-Match` into a version. `*` means "must not exist yet" (create-only). */
function parseIfMatch(
  raw: string | null,
): { ok: true; version: number } | { ok: false } {
  if (raw === null) return { ok: false };
  const trimmed = raw.trim();
  if (trimmed === "*") return { ok: true, version: 0 };
  if (/^W\//.test(trimmed)) return { ok: false };
  const unquoted = trimmed.replace(/^"(.*)"$/, "$1");
  if (!/^\d+$/.test(unquoted)) return { ok: false };
  return { ok: true, version: Number(unquoted) };
}

async function fingerprint(
  request: Request,
  body: string,
  subject: string,
): Promise<string> {
  const url = new URL(request.url);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${request.method}\n${url.pathname}\n${body}\n${subject}`,
      ),
    ),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function capabilities(config: PointerConfig) {
  return {
    protocol: PROTOCOL_VERSION,
    algorithm: "Ed25519",
    pointer: config.name,
    maxValueBytes: MAX_VALUE_BYTES,
    maxCertificateChainDepth: MAX_CHAIN_DEPTH,
    clockSkewSeconds: 60,
    features: {
      optimisticLock: "if-match-version",
      certificateChain: true,
      directSigning: true,
      replayProtection: "nonce",
      idempotentWrites: true,
      scopedReadWrite: true,
    },
    endpoints: {
      value: { methods: ["GET", "PUT"], auth: "signed" },
      capabilities: { methods: ["GET"], auth: "none" },
      health: { methods: ["GET"], auth: "none" },
    },
  };
}

function pointerStub(env: Env, name: string): PointerStub {
  return env.POINTER.get(env.POINTER.idFromName(`${VARIABLE_PREFIX}${name}`));
}

function registryStub(env: Env): RegistryStub {
  return env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
}

async function handleValue(
  request: Request,
  env: Env,
  stub: PointerStub,
  config: PointerConfig,
  nowSeconds: number,
  finish: (response: Response) => Response,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return finish(
      error(405, ERROR_CODES.methodNotAllowed, "use GET or PUT", undefined, {
        allow: "GET, PUT",
      }),
    );
  }

  const authenticated = await authenticate(
    request,
    {
      POINTER_ROOT_PUBLIC_KEY: config.pubkey,
      ...(config.requireAudience ? { REQUIRE_AUDIENCE: true } : {}),
    },
    nowSeconds,
  );
  if (!authenticated.ok) {
    return finish(
      error(
        authenticated.status,
        authenticated.code,
        authenticated.message,
        authenticated.details,
      ),
    );
  }
  const { auth, requestBody } = authenticated;

  let expectedVersion: number | undefined;
  if (request.method === "PUT") {
    if (!auth.scope.write) {
      return finish(
        error(
          403,
          ERROR_CODES.forbidden,
          "this signer may not write the pointer",
        ),
      );
    }
    const match = parseIfMatch(auth.ifMatch);
    if (!match.ok) {
      return finish(
        error(
          428,
          ERROR_CODES.preconditionRequired,
          'writes require `If-Match: "<version>"` (or `If-Match: *` to create)',
        ),
      );
    }
    expectedVersion = match.version;
  } else if (!auth.scope.read) {
    return finish(
      error(403, ERROR_CODES.forbidden, "this signer may not read the pointer"),
    );
  }

  let value: string | undefined;
  if (request.method === "PUT") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(requestBody || "null");
    } catch {
      return finish(
        error(
          400,
          ERROR_CODES.badRequest,
          'body must be JSON: {"value": "..."}',
        ),
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return finish(
        error(400, ERROR_CODES.badRequest, "body must be a JSON object"),
      );
    }
    const record = parsed as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter((k) => k !== "value");
    if (unknownKeys.length > 0) {
      return finish(
        error(
          400,
          ERROR_CODES.badRequest,
          `unknown body field(s): ${unknownKeys.join(", ")}`,
        ),
      );
    }
    if (typeof record.value !== "string") {
      return finish(
        error(400, ERROR_CODES.badRequest, "body.value must be a string"),
      );
    }
    value = record.value;
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) {
    return finish(
      error(
        400,
        ERROR_CODES.badRequest,
        "Idempotency-Key must be 1..200 printable characters",
      ),
    );
  }

  const opRequest: OpRequest = {
    op: request.method === "GET" ? "read" : "write",
    auth,
    ...(value === undefined ? {} : { value }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    ...(idempotencyKey === null
      ? {}
      : {
          idempotencyKey,
          fingerprint: await fingerprint(request, requestBody, auth.subject),
        }),
  };

  let result: OpResult;
  try {
    result = await stub.execute(opRequest, nowSeconds);
  } catch (err) {
    console.error("Pointer Durable Object failure:", err);
    return finish(
      error(500, ERROR_CODES.internal, "pointer storage unavailable"),
    );
  }

  if (!result.ok) {
    const status = STATUS_BY_CODE[result.code] ?? 400;
    return finish(
      error(
        status,
        result.code,
        result.message,
        result.state ? pointerBody(result.state) : undefined,
        result.state ? { etag: etagFor(result.state.version) } : {},
      ),
    );
  }

  return finish(
    shape(result.state, {
      pointer: config.name,
      replayed: result.replayed,
      idempotent: result.idempotent,
      signer: {
        subject: auth.subject,
        keyId: auth.keyId,
        certId: auth.certId,
        direct: auth.direct,
      },
    }),
  );
}

function readJsonObject(
  text: string,
  finish: (response: Response) => Response,
):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "null");
  } catch {
    return {
      ok: false,
      response: finish(error(400, ERROR_CODES.badRequest, "body must be JSON")),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: finish(
        error(400, ERROR_CODES.badRequest, "body must be a JSON object"),
      ),
    };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function onlyKeys(
  body: Record<string, unknown>,
  allowed: string[],
): string | null {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  return extra.length ? extra.join(", ") : null;
}

async function handleAdmin(
  request: Request,
  env: Env,
  nowSeconds: number,
  finish: (response: Response) => Response,
): Promise<Response> {
  if (!env.POINTER_ADMIN_PUBLIC_KEY) {
    return finish(
      error(404, ERROR_CODES.notFound, "admin API is not configured"),
    );
  }

  const authenticated = await authenticate(
    request,
    { POINTER_ROOT_PUBLIC_KEY: env.POINTER_ADMIN_PUBLIC_KEY },
    nowSeconds,
  );
  if (!authenticated.ok) {
    return finish(
      error(
        authenticated.status,
        authenticated.code,
        authenticated.message,
        authenticated.details,
      ),
    );
  }
  if (!authenticated.auth.direct) {
    return finish(
      error(
        403,
        ERROR_CODES.forbidden,
        "admin requests must be signed directly by the admin key",
      ),
    );
  }

  const url = new URL(request.url);
  const tail = url.pathname.slice(ADMIN_PREFIX.length);
  const registry = registryStub(env);

  if (!(await registry.consumeNonce(authenticated.auth.nonce, nowSeconds))) {
    return finish(
      error(
        401,
        ERROR_CODES.replayed,
        "this admin signature has already been used",
      ),
    );
  }

  if (!tail || tail === "/") {
    if (request.method === "GET") {
      return finish(json({ variables: await registry.list() }, 200));
    }
    if (request.method === "POST") {
      const parsed = readJsonObject(authenticated.requestBody, finish);
      if (!parsed.ok) return parsed.response;
      const extra = onlyKeys(parsed.body, [
        "name",
        "pubkey",
        "requireAudience",
      ]);
      if (extra)
        return finish(
          error(400, ERROR_CODES.badRequest, `unknown body field(s): ${extra}`),
        );
      const { name, pubkey } = parsed.body;
      if (
        parsed.body.requireAudience !== undefined &&
        typeof parsed.body.requireAudience !== "boolean"
      )
        return finish(
          error(400, ERROR_CODES.badRequest, "requireAudience must be boolean"),
        );
      if (typeof name !== "string" || !isValidVariableName(name)) {
        return finish(
          error(
            400,
            ERROR_CODES.badRequest,
            "name must be 1..41 lowercase letters, digits or dashes and not reserved",
          ),
        );
      }
      if (typeof pubkey !== "string") {
        return finish(
          error(400, ERROR_CODES.badRequest, "pubkey must be a string"),
        );
      }
      let normalized: string;
      try {
        normalized = (await loadTrustAnchor(pubkey)).publicRaw;
      } catch (err) {
        return finish(
          error(
            400,
            ERROR_CODES.badRequest,
            `pubkey is not a valid Ed25519 key: ${String(err)}`,
          ),
        );
      }

      const config: PointerConfig = {
        name,
        pubkey: normalized,
        createdAt: nowSeconds,
        ...(parsed.body.requireAudience === true
          ? { requireAudience: true }
          : {}),
      };
      const reserved = await registry.create(config);
      if (!reserved) {
        return finish(
          error(409, ERROR_CODES.conflict, `variable "${name}" already exists`),
        );
      }

      const pointer = pointerStub(env, name);
      try {
        const configured = await pointer.configure(config);
        if (!configured) {
          const existing = await pointer.getConfig();
          if (existing) await registry.put({ ...existing, name });
          return finish(
            error(
              409,
              ERROR_CODES.conflict,
              `variable "${name}" already exists`,
            ),
          );
        }
      } catch (err) {
        await registry.remove(name);
        console.error("configure failed:", err);
        return finish(
          error(500, ERROR_CODES.internal, "could not initialize variable"),
        );
      }
      return finish(json(config, 201));
    }
    return finish(
      error(405, ERROR_CODES.methodNotAllowed, "use GET or POST", undefined, {
        allow: "GET, POST",
      }),
    );
  }

  let name: string;
  try {
    name = decodeURIComponent(tail.replace(/^\//, ""));
  } catch {
    return finish(error(400, ERROR_CODES.badRequest, "invalid variable name"));
  }
  if (!isValidVariableName(name)) {
    return finish(error(400, ERROR_CODES.badRequest, "invalid variable name"));
  }

  const existing = await registry.get(name);
  if (!existing) {
    return finish(
      error(
        404,
        ERROR_CODES.unknownPointer,
        `variable "${name}" does not exist`,
      ),
    );
  }

  if (request.method === "GET") {
    const state = await pointerStub(env, name).status();
    return finish(
      json(
        {
          ...existing,
          version: state.version,
          updatedAt: state.updatedAt,
          updatedBy: state.updatedBy,
        },
        200,
      ),
    );
  }

  if (request.method === "PUT") {
    const parsed = readJsonObject(authenticated.requestBody, finish);
    if (!parsed.ok) return parsed.response;
    const extra = onlyKeys(parsed.body, ["pubkey"]);
    if (extra)
      return finish(
        error(400, ERROR_CODES.badRequest, `unknown body field(s): ${extra}`),
      );
    const { pubkey } = parsed.body;
    if (typeof pubkey !== "string") {
      return finish(
        error(400, ERROR_CODES.badRequest, "pubkey must be a string"),
      );
    }
    let normalized: string;
    try {
      normalized = (await loadTrustAnchor(pubkey)).publicRaw;
    } catch (err) {
      return finish(
        error(
          400,
          ERROR_CODES.badRequest,
          `pubkey is not a valid Ed25519 key: ${String(err)}`,
        ),
      );
    }
    const pointer = pointerStub(env, name);
    const updated = await pointer.rotate(normalized);
    if (!updated) {
      await registry.remove(name);
      return finish(
        error(
          404,
          ERROR_CODES.unknownPointer,
          `variable "${name}" does not exist`,
        ),
      );
    }
    await registry.put(updated);
    return finish(json(updated, 200));
  }

  if (request.method === "DELETE") {
    const pointer = pointerStub(env, name);
    try {
      await pointer.destroy();
      await registry.remove(name);
    } catch (err) {
      console.error("delete failed:", err);
      return finish(
        error(500, ERROR_CODES.internal, "could not delete variable"),
      );
    }
    return finish(json({ deleted: name }, 200));
  }

  return finish(
    error(
      405,
      ERROR_CODES.methodNotAllowed,
      "use GET, PUT or DELETE",
      undefined,
      {
        allow: "GET, PUT, DELETE",
      },
    ),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...SECURITY_HEADERS, ...cors },
      });
    }

    const finish = (response: Response): Response => {
      for (const [key, value] of Object.entries(cors)) {
        if (!response.headers.has(key)) response.headers.set(key, value);
      }
      return response;
    };

    if (path === "/" || path === "") {
      if (request.method !== "GET") {
        return finish(
          error(405, ERROR_CODES.methodNotAllowed, "use GET", undefined, {
            allow: "GET",
          }),
        );
      }
      return finish(
        json(
          {
            service: "signed-pointer",
            protocol: PROTOCOL_VERSION,
            data: "/{name}/v1/value",
            admin: ADMIN_PREFIX,
          },
          200,
        ),
      );
    }

    if (path === "/_health") {
      return finish(json({ ok: true, protocol: PROTOCOL_VERSION }, 200));
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    if (path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`)) {
      return handleAdmin(request, env, nowSeconds, finish);
    }

    const segments = path.split("/").filter(Boolean);
    const name = segments[0];
    if (!name || !isValidVariableName(name)) {
      return finish(error(404, ERROR_CODES.unknownPointer, "unknown variable"));
    }
    const route = segments.slice(1).join("/");

    const pointer = pointerStub(env, name);
    let config: PointerConfig | null;
    try {
      config = await pointer.getConfig();
    } catch (err) {
      console.error("Pointer config lookup failed:", err);
      return finish(
        error(500, ERROR_CODES.internal, "pointer storage unavailable"),
      );
    }
    if (!config) {
      return finish(
        error(
          404,
          ERROR_CODES.unknownPointer,
          `variable "${name}" does not exist`,
        ),
      );
    }

    if (route === "" || route === "/") {
      if (request.method !== "GET") {
        return finish(
          error(405, ERROR_CODES.methodNotAllowed, "use GET", undefined, {
            allow: "GET",
          }),
        );
      }
      return finish(json({ pointer: name, protocol: PROTOCOL_VERSION }, 200));
    }

    if (route === "health") {
      return finish(
        json({ ok: true, pointer: name, protocol: PROTOCOL_VERSION }, 200),
      );
    }

    if (route === "v1/capabilities") {
      return finish(json(capabilities(config), 200));
    }

    if (route !== "v1/value") {
      return finish(
        error(
          404,
          ERROR_CODES.notFound,
          `${request.method} ${path} is not a route`,
        ),
      );
    }

    return handleValue(request, env, pointer, config, nowSeconds, finish);
  },
} satisfies ExportedHandler<Env>;
