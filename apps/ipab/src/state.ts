import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CID } from "multiformats/cid";
import type { StoreConfiguration } from "@silvermoon-work/ipfs-store";
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

export function exactCid(value: string, schema = false): string {
  let cid: CID;
  try {
    cid = CID.parse(value).toV1();
  } catch {
    syntax("Expected a valid CID.");
  }
  if (schema && (cid.code !== 0x71 || cid.multihash.code !== 0x12))
    syntax("Schema must be a DAG-CBOR SHA-256 CID.");
  return cid.toString();
}

export function aliasName(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) syntax("Invalid alias name.");
  try {
    CID.parse(value);
  } catch {
    return;
  }
  syntax("An alias name must not itself be a CID.");
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
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "state.sqlite"));
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (name TEXT PRIMARY KEY, cid TEXT NOT NULL);
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
        const row = this.db
          .prepare("SELECT cid FROM aliases WHERE name=?")
          .get(value);
        if (row) return exactCid(String(row.cid), schema);
        throw new HostError(
          `Unknown CID or alias "${value}". Run ipab alias list.`,
        );
      }
      throw error;
    }
  }
  setAlias(
    name: string,
    cid: string,
    replace: boolean,
  ): { name: string; cid: string } {
    aliasName(name);
    cid = exactCid(cid);
    this.transaction(() => {
      const old = this.db
        .prepare("SELECT cid FROM aliases WHERE name=?")
        .get(name);
      if (old && old.cid !== cid && !replace)
        throw new HostError(
          `Alias "${name}" has another target; use --replace.`,
        );
      this.db
        .prepare("INSERT OR REPLACE INTO aliases VALUES (?,?)")
        .run(name, cid);
    });
    return { name, cid };
  }
  removeAlias(name: string): void {
    aliasName(name);
    if (!this.db.prepare("DELETE FROM aliases WHERE name=?").run(name).changes)
      throw new HostError(
        `Alias "${name}" does not exist. Run ipab alias list.`,
      );
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
