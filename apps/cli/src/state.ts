import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CID } from "multiformats/cid";
import type { StoreConfiguration } from "@ipab/ipfs-store";
import {
  validateUserConfig,
  type ConfigKey,
  type ConfigValue,
} from "./config.js";
import { HostError, object, syntax } from "./errors.js";

export interface Association {
  schemaCid: string;
  appCid: string;
  argv: string[];
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
export interface PinMetadata {
  kind: "bundle" | "schema" | "content";
  typeName: string | null;
  schemaCid: string | null;
}
export interface NamedPin {
  name: string;
  cid: string;
  owner: string;
  status: "pending" | "ready" | "deleting";
  metadata: PinMetadata | null;
  builtin?: true;
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
    object(data.backend, "original Store configuration");
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
  } catch {
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
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "state.sqlite"));
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (name TEXT PRIMARY KEY, cid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS named_pins (name TEXT PRIMARY KEY, owner TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registrations (schema_cid TEXT PRIMARY KEY, value TEXT NOT NULL);
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
    this.db
      .prepare("INSERT OR REPLACE INTO config VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  resetConfig(key: ConfigKey): void {
    this.db.prepare("DELETE FROM config WHERE key=?").run(key);
  }
  aliases(): { name: string; cid: string }[] {
    return this.db
      .prepare("SELECT name,cid FROM aliases ORDER BY name")
      .all()
      .map((row) => ({
        name: String(row.name),
        cid: exactCid(String(row.cid)),
      }));
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
          if (pin.status !== "ready")
            throw new HostError(
              `Pin "${value}" is ${pin.status}; retry pin add/delete before using it.`,
            );
          return exactCid(pin.cid, schema);
        }
        if (this.db.prepare("SELECT 1 FROM aliases WHERE name=?").get(value))
          throw new HostError(
            `Legacy Alias "${value}" is not a pin. Read its CID from the preserved aliases table and run ipab pin add NAME CID to verify and retain it.`,
          );
        throw new HostError(
          `Unknown CID or pin "${value}". Run ipab pin list.`,
        );
      }
      throw error;
    }
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
        if (value.typeName !== null || value.schemaCid !== null)
          throw new HostError("Invalid persisted pin type metadata.");
        metadata = { kind: "content", typeName: null, schemaCid: null };
      } else {
        if (
          (value.kind !== "bundle" && value.kind !== "schema") ||
          typeof value.typeName !== "string" ||
          typeof value.schemaCid !== "string"
        )
          throw new HostError("Invalid persisted pin type metadata.");
        metadata = {
          kind: value.kind,
          typeName: value.typeName,
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
