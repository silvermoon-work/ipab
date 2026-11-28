import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface OwnedNode {
  scope: string;
  repo: string;
  api: number;
  peerId: string;
  auth: string;
  swarm: number;
  pid?: number;
  epoch?: number;
}
function processObject(): Record<string, unknown> {
  const value: unknown = Reflect.get(globalThis, "process");
  if (!value || typeof value !== "object")
    throw new Error("Node process is unavailable");
  return value as Record<string, unknown>;
}
export function nodeRuntime() {
  const process = processObject();
  if (
    typeof process.execPath !== "string" ||
    typeof process.platform !== "string" ||
    !process.env ||
    typeof process.env !== "object" ||
    Array.isArray(process.env)
  )
    throw new Error("Invalid Node runtime");
  const env: NodeJS.ProcessEnv = {};
  const environment = process.env as Record<string, unknown>;
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string" && value !== undefined)
      throw new Error("Invalid Node environment");
    env[key] = value;
  }
  return { execPath: process.execPath, platform: process.platform, env };
}
function record(value: unknown, directory: string, scope: string): OwnedNode {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid owned node record");
  const fields = value as Record<string, unknown>;
  const { api, peerId, auth, swarm, pid, epoch } = fields;
  if (
    typeof api !== "number" ||
    typeof swarm !== "number" ||
    typeof peerId !== "string" ||
    typeof auth !== "string" ||
    !Number.isSafeInteger(api) ||
    api < 1 ||
    api > 65535 ||
    !Number.isSafeInteger(swarm) ||
    swarm < 1 ||
    swarm > 65535 ||
    (pid !== undefined &&
      (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)) ||
    (epoch !== undefined &&
      (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1))
  )
    throw new Error(`Invalid owned node record at ${directory}`);
  return {
    scope,
    repo: join(directory, "repo"),
    api,
    peerId,
    auth,
    swarm,
    ...(pid !== undefined ? { pid } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
  };
}
export async function ownedNodes(
  state: string,
  rootMayBeAbsent: boolean,
): Promise<OwnedNode[]> {
  const root = join(state, "swarm-nodes");
  let scopes: string[];
  try {
    scopes = await readdir(root);
  } catch (cause) {
    if (
      rootMayBeAbsent &&
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ENOENT"
    )
      return [];
    throw cause;
  }
  return Promise.all(
    scopes.map(async (scope) =>
      record(
        JSON.parse(
          await readFile(join(root, scope, "node.json"), "utf8"),
        ) as unknown,
        join(root, scope),
        scope,
      ),
    ),
  );
}
export function pidAlive(pid: number): boolean {
  try {
    const process = processObject(),
      kill = process.kill;
    if (typeof kill !== "function")
      throw new Error("Node PID inspection is unavailable");
    Reflect.apply(kill, process, [pid, 0]);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return false;
    throw cause;
  }
}
export async function waitOwnedPid(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Owned PID ${pid} did not exit`);
}
export async function shutdownOwned(node: OwnedNode): Promise<void> {
  if (node.pid === undefined || !pidAlive(node.pid)) return;
  const request = (command: string) =>
    fetch(`http://127.0.0.1:${node.api}/api/v0/${command}`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.auth}` },
      signal: AbortSignal.timeout(5000),
    });
  const identity = await request("id");
  if (!identity.ok) throw new Error(`Cannot verify owned PID ${node.pid}`);
  const value: unknown = await identity.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("ID" in value) ||
    value.ID !== node.peerId
  )
    throw new Error(
      `PeerID mismatch for owned PID ${node.pid}; refusing shutdown`,
    );
  const response = await request("shutdown");
  if (!response.ok)
    throw new Error(`Shutdown failed for owned PID ${node.pid}`);
  await response.body?.cancel();
  await waitOwnedPid(node.pid);
}
