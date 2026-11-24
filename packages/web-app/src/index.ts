import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { hostPage } from "./host.js";
import {
  errorReply,
  json,
  MAX_BYTES,
  name,
  object,
  type JsonValue,
} from "./protocol.js";

export type { JsonValue, BackendEvent } from "./protocol.js";
export interface Parser<T extends JsonValue> {
  parse(value: unknown): T;
}
export interface WebAppCall {
  signal: AbortSignal;
  emit(this: void, name: string, data: JsonValue): void;
}
const methodBrand = Symbol("WebAppMethod");
export interface WebAppMethod {
  readonly [methodBrand]: true;
  invoke(input: unknown, call: WebAppCall): Promise<JsonValue>;
}
export function defineWebAppMethod<
  I extends JsonValue,
  O extends JsonValue,
>(definition: {
  request: Parser<I>;
  response: Parser<O>;
  handle(input: I, call: WebAppCall): O | Promise<O>;
}): WebAppMethod {
  return {
    [methodBrand]: true,
    async invoke(input, call) {
      const parsed = definition.request.parse(json(input));
      json(parsed);
      const output = await definition.handle(parsed, call);
      return json(definition.response.parse(json(output)));
    },
  };
}
export interface WebAppContext {
  appCid: string;
  readFile(
    rootCid: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
}
export interface RunWebAppOptions {
  context: WebAppContext;
  frontendRoot: string;
  handlers: Readonly<Record<string, WebAppMethod>>;
  onDiagnostic?: (message: string) => void;
  signal?: AbortSignal;
}

const mime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
};

function safePath(path: string): string {
  if (
    !path ||
    path
      .split("/")
      .some((part) => !/^[a-zA-Z0-9_@.-]+$/.test(part) || part.startsWith("."))
  )
    throw new Error("Invalid asset path");
  return path;
}

interface Session {
  calls: Map<string, AbortController>;
  events: JsonValue[];
  poll?: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
}

export async function runWebApp(options: RunWebAppOptions): Promise<void> {
  const root = safePath(options.frontendRoot);
  for (const method of Object.keys(options.handlers)) {
    name(method);
    if (!options.handlers[method]?.[methodBrand])
      throw new Error("Handlers must use defineWebAppMethod with both parsers");
  }
  const diagnostic = options.onDiagnostic ?? console.error;
  const secret = randomBytes(24).toString("hex");
  const sessions = new Map<string, Session>();
  const assets = new Set<AbortController>();
  const cancellations = new Set<Promise<void>>();
  const cleanupErrors: Error[] = [];
  let origin = "";
  let host = "";
  let closing = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const reply = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(json(value)));
  };
  const drop = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    for (const controller of session.calls.values()) controller.abort();
    if (session.poll) reply(session.poll, { events: [] });
    sessions.delete(id);
    if (!closing && sessions.size === 0)
      reconnect = setTimeout(() => {
        stop();
      }, 3000);
  };
  const touch = (id: string, session: Session) => {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      drop(id);
    }, 30_000);
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else
        reply(
          response,
          { error: { code: "BadRequest", message: "BadRequest" } },
          400,
        );
    });
  });
  function stop(error?: Error) {
    if (closing) return;
    closing = true;
    clearTimeout(reconnect);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    options.signal?.removeEventListener("abort", interrupted);
    for (const id of sessions.keys()) drop(id);
    for (const controller of assets) controller.abort();
    server.close((failure) => {
      void Promise.all(cancellations).then(() => {
        if (failure) cleanupErrors.push(failure);
        if (cleanupErrors.length)
          rejectClosed(
            new AggregateError(
              [...(error ? [error] : []), ...cleanupErrors],
              "Web App cleanup failed",
            ),
          );
        else if (error) rejectClosed(error);
        else resolveClosed();
      });
    });
    server.closeAllConnections();
  }
  function interrupted() {
    stop(new DOMException("Web App cancelled", "AbortError"));
  }
  async function serve(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.headers.host !== host || closing) {
      reply(response, {}, 403);
      return;
    }
    const path = request.url;
    if (request.method === "GET" && path === "/") {
      if (request.headers.origin && request.headers.origin !== origin) {
        reply(response, {}, 403);
        return;
      }
      response.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${secret}'; style-src 'unsafe-inline'; frame-src ${origin}; connect-src ${origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      );
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(hostPage(secret));
      return;
    }
    if (request.method === "GET" && path?.startsWith("/frame/")) {
      if (request.headers.origin && request.headers.origin !== "null") {
        reply(response, {}, 403);
        return;
      }
      const relative = safePath(decodeURIComponent(path.slice(7)));
      const type = mime[relative.split(".").at(-1)!];
      if (!type) {
        reply(response, {}, 415);
        return;
      }
      const controller = new AbortController();
      assets.add(controller);
      response.once("close", () => {
        controller.abort();
      });
      try {
        const stream = await options.context.readFile(
          options.context.appCid,
          `${root}/${relative}`,
          { signal: controller.signal },
        );
        const reader = stream.getReader();
        const cancel = () => {
          const cancellation = reader.cancel().catch((error: unknown) => {
            cleanupErrors.push(
              error instanceof Error
                ? error
                : new Error("Asset cleanup failed"),
            );
          });
          cancellations.add(cancellation);
          void cancellation.finally(() => cancellations.delete(cancellation));
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        if (controller.signal.aborted) cancel();
        response.setHeader("Content-Type", type);
        response.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
        response.setHeader("Access-Control-Allow-Origin", "null");
        response.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; script-src ${origin}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; font-src ${origin}; connect-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`,
        );
        try {
          while (!controller.signal.aborted) {
            const next = await reader.read();
            if (next.done) break;
            if (!response.write(next.value))
              await new Promise<void>((resolve) => {
                const finish = () => {
                  response.removeListener("drain", finish);
                  controller.signal.removeEventListener("abort", finish);
                  resolve();
                };
                response.once("drain", finish);
                controller.signal.addEventListener("abort", finish, {
                  once: true,
                });
              });
          }
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
        response.end();
      } finally {
        assets.delete(controller);
      }
      return;
    }
    if (
      request.method !== "POST" ||
      request.headers.origin !== origin ||
      request.headers["x-ipab-web"] !== secret ||
      request.headers["content-type"] !== "application/json"
    ) {
      reply(response, {}, 403);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > MAX_BYTES) throw new Error("Request too large");
      chunks.push(buffer);
    }
    const body = object(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    );
    if (path === "/session") {
      if (sessions.size >= 32) throw new Error("Session limit exceeded");
      clearTimeout(reconnect);
      const id = randomBytes(24).toString("hex");
      const session: Session = {
        calls: new Map(),
        events: [],
        timer: setTimeout(() => {
          drop(id);
        }, 30_000),
      };
      sessions.set(id, session);
      reply(response, { session: id });
      return;
    }
    if (typeof body.session !== "string") throw new Error("Invalid session");
    const sessionId = body.session;
    const session = sessions.get(sessionId);
    if (!session) throw new Error("Unknown session");
    touch(sessionId, session);
    if (path === "/disconnect") {
      drop(sessionId);
      reply(response, {});
    } else if (path === "/poll") {
      if (session.poll) throw new Error("Already polling");
      if (session.events.length)
        reply(response, { events: session.events.splice(0) });
      else {
        session.poll = response;
        const timer = setTimeout(() => {
          delete session.poll;
          reply(response, { events: [] });
        }, 10_000);
        response.once("close", () => {
          clearTimeout(timer);
          delete session.poll;
        });
      }
    } else if (path === "/cancel") {
      session.calls.get(name(body.id))?.abort();
      reply(response, {});
    } else if (path === "/call") {
      const id = name(body.id);
      const method = name(body.method);
      const handler = Object.hasOwn(options.handlers, method)
        ? options.handlers[method]
        : undefined;
      if (!handler || session.calls.has(id) || session.calls.size >= 32) {
        reply(response, errorReply(id, "UnavailableMethod"));
        return;
      }
      const controller = new AbortController();
      session.calls.set(id, controller);
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);
      try {
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("Cancelled"));
            },
            { once: true },
          );
        });
        const result = await Promise.race([
          handler.invoke(body.input, {
            signal: controller.signal,
            emit(eventName, data) {
              if (controller.signal.aborted) return;
              const event = json({
                type: "event",
                name: name(eventName),
                data: json(data),
              });
              if (session.events.length >= 64)
                throw new Error("Event limit exceeded");
              json({ events: [...session.events, event] });
              session.events.push(event);
              if (session.poll) {
                const poll = session.poll;
                delete session.poll;
                reply(poll, { events: session.events.splice(0) });
              }
            },
          }),
          aborted,
        ]);
        reply(response, { type: "result", id, value: json(result) });
      } catch {
        reply(
          response,
          errorReply(
            id,
            controller.signal.aborted ? "Cancelled" : "MethodFailed",
          ),
        );
      } finally {
        clearTimeout(timeout);
        controller.abort();
        session.calls.delete(id);
      }
    } else reply(response, {}, 404);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  options.signal?.addEventListener("abort", interrupted, { once: true });
  if (options.signal?.aborted) interrupted();
  else {
    try {
      diagnostic(`Web App URL: ${origin}/ (waiting for frontend connection)`);
    } catch (error) {
      stop(error instanceof Error ? error : new Error("Diagnostic failed"));
    }
  }
  return closed;
}
