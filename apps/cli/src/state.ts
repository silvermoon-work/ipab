import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CID } from "multiformats/cid";
import type { StoreConfiguration } from "@ipab/ipfs-store";
import {
  validateUserConfig,
  swarmUrl,
  type ConfigKey,
  type ConfigValue,
} from "./config.js";
import { HostError, object, syntax } from "./errors.js";
import { secureConfigurationStorage } from "./config-secret.js";

export interface Association {
  schemaCid: string;
  appCid: string;
  argv: string[];
}
export interface RegisteredSwarm {
  // Keep the storage column name, but values are configuration URLs; old CID rows are rejected.
  cid: string;
  alias: string | null;
}
export function swarmAlias(value: string): void {
  pinName(value);
}
export interface RunRecord {
  id: string;
  origin: "exec" | "open";
  appCid: string;
  argv: string[];
  startedAt: string;
  endedAt: string;
  status: "succeeded" | "failed" | "cancelled";
  outputCid: string | null;
  appExitCode: number | null;
  log?: "complete" | "incomplete";
  error: { phase: string; code: string; message: string } | null;
  retention: {
    owned: boolean;
    state: "none" | "retained" | "releasing" | "pending";
    owner?: string;
  };
}
export interface Hold {
  owner: string;
  backend: StoreConfiguration;
  roots: string[];
  pid: number | null;
  session: string | null;
  recordId: string | null;
}
export type PinMetadata =
  | { kind: "bundle"; title: string; schemaCid: string }
  | { kind: "schema"; title: string; schemaCid: string }
  | { kind: "content"; title: null; schemaCid: null };
export interface NamedPin {
  name: string;
  cid: string;
  owner: string;
  status: "pending" | "ready" | "deleting";
  metadata: PinMetadata | null;
  builtin?: true;
}
export function bundlePinMetadata(pin: NamedPin) {
  if (pin.status !== "ready" || !pin.metadata)
    throw new HostError(
      `Pin "${pin.name}" is ${pin.status}; retry pin add/delete before using it.`,
    );
  if (pin.metadata.kind !== "bundle")
    throw new HostError(
      `Pin "${pin.name}" is not a Bundle pin. Its retention is preserved; run ipab pin delete ${pin.name}, then wrap the content in a Bundle before adding a new pin.`,
    );
  return pin.metadata;
}

export function exactCid(value: string, schema = false): string {
  let cid: CID;
  try {
    cid = CID.parse(value).toV1();
  } catch {
    syntax("Expected a valid CID.");
  }
  if (schema && (cid.code !== 0x71 || cid.multihash.code !== 0x12))
    syntax("Schema must be a DAG-CBOR SHA-256 block CID.");
  return cid.toString();
}

export function pinName(value: string, builtin = false): void {
  if (value.startsWith("builtin:")) {
    if (builtin && /^builtin:[A-Za-z][A-Za-z0-9._-]*$/.test(value)) return;
    syntax(
      "Built-in pins are read-only and cannot be added, deleted or renamed.",
    );
  }
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value))
    syntax("Invalid pin name; builtin names are reserved.");
  try {
    CID.parse(value);
  } catch {
    return;
  }
  syntax("A pin name must not itself be a CID.");
}

function persistedHold(value: string, owner: string): Hold {
  try {
    const data = object(JSON.parse(value) as unknown, "retention metadata");
    const backend = object(data.backend, "original Store configuration");
    if (backend.backend === "kubo")
      throw new HostError(
        "This retention record belongs to the removed Kubo RPC Store. It is not migrated or released. Create a new local pin and manage the old daemon pin independently.",
        1,
        "LEGACY_STORE",
      );
    if (
      data.owner !== owner ||
      !Array.isArray(data.roots) ||
      data.roots.some((root: unknown) => typeof root !== "string") ||
      (data.pid !== null &&
        (!Number.isSafeInteger(data.pid) || Number(data.pid) <= 0)) ||
      (data.session !== null && typeof data.session !== "string") ||
      (data.recordId !== null && typeof data.recordId !== "string")
    )
      throw new Error("Invalid retention fields.");
    for (const root of data.roots as string[]) exactCid(root);
    return data as unknown as Hold;
  } catch (error) {
    if (error instanceof HostError && error.code === "LEGACY_STORE")
      throw error;
    throw new HostError(
      "Invalid persisted retention metadata; cleanup is blocked.",
      1,
      "STATE_INVALID",
    );
  }
}

export class State {
  readonly db: DatabaseSync;
  readonly identity: string;
  constructor(
    readonly directory: string,
    private readonly builtins: readonly NamedPin[] = [],
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "state.sqlite"));
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      DROP TABLE IF EXISTS aliases;
      CREATE TABLE IF NOT EXISTS named_pins (name TEXT PRIMARY KEY, owner TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registrations (schema_cid TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS swarms (cid TEXT PRIMARY KEY, alias TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS swarm_headers (account TEXT NOT NULL, swarm TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (account,swarm));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS holds (owner TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.transaction(() => {
      if (!this.db.prepare("SELECT id FROM identity").get())
        this.db.prepare("INSERT INTO identity VALUES (?)").run(randomUUID());
    });
    this.identity = String(
      this.db.prepare("SELECT id FROM identity").get()!.id,
    );
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  config(): Partial<Record<ConfigKey, ConfigValue>> {
    const entries = this.db.prepare("SELECT key,value FROM config").all();
    if (
      entries.some(
        (row) => row.key === "pointers.apiKey" && row.value !== "null",
      )
    )
      secureConfigurationStorage(this.directory, false);
    if (entries.some((row) => row.key === "store.rpc"))
      throw new HostError(
        "store.rpc is no longer supported. Run ipab config reset store.rpc, then configure store.gateway with an HTTP gateway URL. Existing Kubo pins are not migrated or released.",
      );
    try {
      return validateUserConfig(
        Object.fromEntries(
          entries.map((row) => [
            row.key,
            JSON.parse(String(row.value)) as unknown,
          ]),
        ),
      );
    } catch {
      throw new HostError(
        "Malformed user configuration; inspect the state database configuration.",
      );
    }
  }
  setConfig(key: ConfigKey, value: ConfigValue): void {
    if (key === "pointers.apiKey" && value !== null)
      secureConfigurationStorage(this.directory, true);
    this.db
      .prepare("INSERT OR REPLACE INTO config VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  resetConfig(key: ConfigKey | "store.rpc"): void {
    this.db.prepare("DELETE FROM config WHERE key=?").run(key);
  }
  swarms(): RegisteredSwarm[] {
    return this.db
      .prepare("SELECT cid,alias FROM swarms ORDER BY cid")
      .all()
      .map((row) => {
        if (
          typeof row.cid !== "string" ||
          (row.alias !== null && typeof row.alias !== "string")
        )
          throw new HostError("Invalid persisted swarm registration.");
        const cid = swarmUrl(row.cid);
        if (row.alias !== null) swarmAlias(row.alias);
        return { cid, alias: row.alias };
      });
  }
  resolveSwarm(reference: string): string {
    if (/^https?:/.test(reference)) return swarmUrl(reference);
    {
      const entry = this.swarms().find((entry) => entry.alias === reference);
      if (entry) return entry.cid;
      throw new HostError(
        `Unknown swarm alias "${reference}". Run ipab swarm list.`,
      );
    }
  }
  registeredSwarm(reference: string): RegisteredSwarm {
    const cid = this.resolveSwarm(reference);
    const entry = this.swarms().find((entry) => entry.cid === cid);
    if (!entry)
      throw new HostError(
        `Swarm "${reference}" is not registered. Run ipab swarm add ${cid}.`,
      );
    return entry;
  }
  checkSwarmAlias(alias: string, cid?: string): void {
    swarmAlias(alias);
    if (
      this.swarms().some((entry) => entry.alias === alias && entry.cid !== cid)
    )
      throw new HostError(
        `Swarm alias "${alias}" is already assigned. Choose another alias.`,
      );
  }
  registerSwarm(cid: string, alias?: string): RegisteredSwarm {
    cid = swarmUrl(cid);
    return this.transaction(() => {
      if (alias !== undefined) this.checkSwarmAlias(alias, cid);
      const previous = this.swarms().find((entry) => entry.cid === cid);
      const entry = { cid, alias: alias ?? previous?.alias ?? null };
      this.db
        .prepare("INSERT OR REPLACE INTO swarms VALUES (?,?)")
        .run(cid, entry.alias);
      if (this.config()["swarm.default"] == null)
        this.setConfig("swarm.default", cid);
      return entry;
    });
  }
  useSwarm(reference: string): string {
    return this.transaction(() => {
      const entry = this.registeredSwarm(reference);
      this.setConfig("swarm.default", entry.cid);
      return entry.cid;
    });
  }
  removeSwarm(reference: string): string {
    return this.transaction(() => {
      const entry = this.registeredSwarm(reference);
      this.db.prepare("DELETE FROM swarms WHERE cid=?").run(entry.cid);
      if (this.config()["swarm.default"] === entry.cid)
        this.resetConfig("swarm.default");
      return entry.cid;
    });
  }
  swarmHeader(account: string, swarm: string): unknown {
    const row = this.db
      .prepare("SELECT value FROM swarm_headers WHERE account=? AND swarm=?")
      .get(account, swarm);
    if (!row) return undefined;
    try {
      return JSON.parse(String(row.value)) as unknown;
    } catch {
      throw new HostError("Malformed persisted swarm header cache.");
    }
  }
  saveSwarmHeader(account: string, swarm: string, value: unknown): void {
    this.db
      .prepare("INSERT OR REPLACE INTO swarm_headers VALUES (?,?,?)")
      .run(account, swarm, JSON.stringify(value));
  }
  invalidateSwarmHeader(swarm: string): void {
    this.db.prepare("DELETE FROM swarm_headers WHERE swarm=?").run(swarm);
  }
  resolve(value: string, schema = false): string {
    try {
      return exactCid(value, schema);
    } catch (error) {
      try {
        CID.parse(value);
      } catch {
        const pin = this.pin(value);
        if (pin) {
          const metadata = bundlePinMetadata(pin);
          if (schema) return metadata.schemaCid;
          return exactCid(pin.cid, schema);
        }
        throw new HostError(
          `Unknown CID or pin "${value}". Run ipab pin list.`,
        );
      }
      throw error;
    }
  }
  resolvePin(name: string): string | undefined {
    const pin = this.pin(name);
    if (!pin) return undefined;
    bundlePinMetadata(pin);
    return exactCid(pin.cid);
  }
  pins(): NamedPin[] {
    const user = this.db
      .prepare("SELECT name,owner,value FROM named_pins ORDER BY name")
      .all()
      .map((row) =>
        this.readPin(String(row.name), String(row.owner), String(row.value)),
      );
    return [...user, ...this.builtins];
  }
  pin(name: string): NamedPin | undefined {
    const builtin = this.builtins.find((pin) => pin.name === name);
    if (builtin) return builtin;
    const row = this.db
      .prepare("SELECT owner,value FROM named_pins WHERE name=?")
      .get(name);
    return row
      ? this.readPin(name, String(row.owner), String(row.value))
      : undefined;
  }
  private readPin(name: string, owner: string, value: string): NamedPin {
    const data = object(JSON.parse(value) as unknown, "named pin");
    if (
      data.name !== name ||
      data.owner !== owner ||
      typeof data.cid !== "string" ||
      (data.status !== "pending" &&
        data.status !== "ready" &&
        data.status !== "deleting")
    )
      throw new HostError("Invalid persisted named pin; recovery is blocked.");
    exactCid(data.cid);
    let metadata: PinMetadata | null = null;
    if (data.metadata !== null) {
      const value = object(data.metadata, "pin type metadata");
      if (value.kind === "content") {
        if (value.title !== null || value.schemaCid !== null)
          throw new HostError("Invalid persisted pin type metadata.");
        metadata = { kind: "content", title: null, schemaCid: null };
      } else {
        if (
          (value.kind !== "bundle" && value.kind !== "schema") ||
          typeof value.title !== "string" ||
          !value.title.trim() ||
          typeof value.schemaCid !== "string"
        )
          throw new HostError("Invalid persisted pin type metadata.");
        metadata = {
          kind: value.kind,
          title: value.title,
          schemaCid: exactCid(value.schemaCid, true),
        };
      }
    } else if (data.status === "ready")
      throw new HostError("Ready pin is missing type metadata.");
    return {
      name,
      cid: data.cid,
      owner,
      status: data.status,
      metadata,
    };
  }
  savePin(pin: NamedPin): void {
    pinName(pin.name);
    if (
      !this.db
        .prepare(
          "INSERT INTO named_pins VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value WHERE owner=excluded.owner",
        )
        .run(pin.name, pin.owner, JSON.stringify(pin)).changes
    )
      throw new HostError(`Pin name "${pin.name}" is occupied.`);
  }
  isPinOwner(owner: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM named_pins WHERE owner=?").get(owner),
    );
  }
  deletePin(name: string): void {
    pinName(name);
    this.db.prepare("DELETE FROM named_pins WHERE name=?").run(name);
  }
  registrations(): Association[] {
    return this.db
      .prepare("SELECT value FROM registrations ORDER BY schema_cid")
      .all()
      .map((row) => JSON.parse(String(row.value)) as Association);
  }
  association(schemaCid: string): Association | undefined {
    const row = this.db
      .prepare("SELECT value FROM registrations WHERE schema_cid=?")
      .get(schemaCid);
    return row ? (JSON.parse(String(row.value)) as Association) : undefined;
  }
  setAssociation(
    schema: string,
    app: string,
    argv: string[],
    replace: boolean,
  ): Association {
    const value: Association = {
      schemaCid: this.resolve(schema, true),
      appCid: this.resolve(app),
      argv,
    };
    if (!argv.length || !argv.includes("%"))
      syntax('Argument template must contain a whole "%" argument.');
    this.transaction(() => {
      const old = this.association(value.schemaCid);
      if (old && JSON.stringify(old) !== JSON.stringify(value) && !replace)
        throw new HostError(
          "Schema has another association; use --replace before --.",
        );
      this.db
        .prepare("INSERT OR REPLACE INTO registrations VALUES (?,?)")
        .run(value.schemaCid, JSON.stringify(value));
    });
    return value;
  }
  removeAssociation(schema: string): string {
    const cid = this.resolve(schema, true);
    if (
      !this.db.prepare("DELETE FROM registrations WHERE schema_cid=?").run(cid)
        .changes
    )
      throw new HostError(
        "No association exists for this Schema. Run ipab register list.",
      );
    return cid;
  }
  runs(): RunRecord[] {
    return this.db
      .prepare("SELECT value FROM runs")
      .all()
      .map((row) => JSON.parse(String(row.value)) as RunRecord);
  }
  private matchingRunIds(prefix: string): string[] {
    // Prefixes are literal identifiers, not GLOB patterns.
    const pattern = `${prefix.replaceAll("[", "[[]").replaceAll("*", "[*]").replaceAll("?", "[?]")}*`;
    return this.db
      .prepare("SELECT id FROM runs WHERE id GLOB ? ORDER BY id LIMIT 2")
      .all(pattern)
      .map((row) => String(row.id));
  }
  shortRunId(id: string): string {
    let length = Math.min(8, id.length);
    while (
      length < id.length &&
      this.matchingRunIds(id.slice(0, length)).length > 1
    )
      length++;
    return id.slice(0, length);
  }
  resolveRunId(value: string): string {
    if (this.db.prepare("SELECT id FROM runs WHERE id=?").get(value))
      return value;
    if (value.length >= 8) {
      const matches = this.matchingRunIds(value);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1)
        throw new HostError(
          `Ambiguous run ID prefix "${value}"; use more characters or the full ID.`,
        );
    }
    throw new HostError(
      `Execution record "${value}" does not exist. Run ipab history list.`,
    );
  }
  run(id: string): RunRecord {
    const row = this.db.prepare("SELECT value FROM runs WHERE id=?").get(id);
    if (!row)
      throw new HostError(
        `Execution record "${id}" does not exist. Run ipab history list.`,
      );
    return JSON.parse(String(row.value)) as RunRecord;
  }
  saveRun(record: RunRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO runs VALUES (?,?)")
      .run(record.id, JSON.stringify(record));
  }
  deleteRun(id: string): void {
    this.db.prepare("DELETE FROM runs WHERE id=?").run(id);
  }
  holds(): Hold[] {
    return this.db
      .prepare("SELECT owner,value FROM holds")
      .all()
      .map((row) => persistedHold(String(row.value), String(row.owner)));
  }
  hold(owner: string): Hold | undefined {
    const row = this.db
      .prepare("SELECT value FROM holds WHERE owner=?")
      .get(owner);
    return row ? persistedHold(String(row.value), owner) : undefined;
  }
  saveHold(hold: Hold): void {
    this.db
      .prepare("INSERT OR REPLACE INTO holds VALUES (?,?)")
      .run(hold.owner, JSON.stringify(hold));
  }
  deleteHold(owner: string): void {
    this.db.prepare("DELETE FROM holds WHERE owner=?").run(owner);
  }
}
