import { IpfsStore, type StoreConfiguration } from "@ipab/ipfs-store";
import type { SQLInputValue } from "node:sqlite";
import { HostError, message, syntax } from "./errors.js";
import type { Hold, RunRecord, State } from "./state.js";

export interface Filters {
  app?: string;
  status?: RunRecord["status"];
  since?: number;
  until?: number;
}

export function timestamp(value: string): number {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    syntax(
      "Time must be RFC3339 with Z or an explicit timezone offset and at most three fractional second digits.",
    );
  const number = Date.parse(value);
  const [, year, month, day, hour, minute, second] =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)!;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month), 0);
  const days = calendar.getUTCDate();
  if (
    !Number.isFinite(number) ||
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    syntax("Invalid RFC3339 timestamp.");
  return number;
}

export function filters(
  state: State,
  options: Record<string, string | boolean>,
): Filters {
  const result: Filters = {};
  if (typeof options.app === "string") result.app = state.resolve(options.app);
  if (typeof options.status === "string") {
    if (!["succeeded", "failed", "cancelled"].includes(options.status))
      syntax("Invalid execution status.");
    result.status = options.status as RunRecord["status"];
  }
  if (typeof options.since === "string")
    result.since = timestamp(options.since);
  if (typeof options.until === "string")
    result.until = timestamp(options.until);
  if (
    result.since !== undefined &&
    result.until !== undefined &&
    result.since >= result.until
  )
    syntax("--since must precede --until.");
  return result;
}

const endedTime =
  "CAST(round((julianday(json_extract(value,'$.endedAt'))-2440587.5)*86400000) AS INTEGER)";
function selection(
  filter: Filters,
  before?: RunRecord,
): { where: string; parameters: SQLInputValue[] } {
  const conditions: string[] = [];
  const parameters: SQLInputValue[] = [];
  for (const [field, value] of [
    ["appCid", filter.app],
    ["status", filter.status],
  ] as const) {
    if (value !== undefined) {
      conditions.push(`json_extract(value,'$.${field}')=?`);
      parameters.push(value);
    }
  }
  if (filter.since !== undefined) {
    conditions.push(`${endedTime}>=?`);
    parameters.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push(`${endedTime}<?`);
    parameters.push(filter.until);
  }
  if (before) {
    conditions.push(`(${endedTime}<? OR (${endedTime}=? AND id<?))`);
    parameters.push(
      Date.parse(before.endedAt),
      Date.parse(before.endedAt),
      before.id,
    );
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    parameters,
  };
}

export function selectedIds(state: State, filter: Filters): string[] {
  const query = selection(filter);
  return state.db
    .prepare(
      `SELECT id FROM runs ${query.where} ORDER BY ${endedTime} DESC,id DESC`,
    )
    .all(...query.parameters)
    .map((row) => String(row.id));
}

export function listHistory(
  state: State,
  filter: Filters,
  limit: number,
  before?: string,
): {
  items: Omit<RunRecord, "origin" | "appExitCode" | "error" | "retention">[];
  nextBefore: string | null;
} {
  const query = selection(
    filter,
    before !== undefined ? state.run(before) : undefined,
  );
  const records = state.db
    .prepare(
      `SELECT value FROM runs ${query.where} ORDER BY ${endedTime} DESC,id DESC LIMIT ?`,
    )
    .all(
      ...query.parameters,
      limit < Number.MAX_SAFE_INTEGER ? limit + 1 : limit,
    )
    .map((row) => JSON.parse(String(row.value)) as RunRecord);
  const page = records.slice(0, limit);
  return {
    items: page.map(
      ({ id, appCid, argv, startedAt, endedAt, status, outputCid }) => ({
        id,
        appCid,
        argv,
        startedAt,
        endedAt,
        status,
        outputCid,
      }),
    ),
    nextBefore: records.length > page.length ? page.at(-1)!.id : null,
  };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class Ownership {
  constructor(
    readonly state: State,
    readonly store: IpfsStore,
    readonly owner: string,
  ) {}
  static async create(
    state: State,
    store: IpfsStore,
    id: string,
    session: string | null,
  ): Promise<Ownership> {
    const owner = `ipab:${state.identity}:${id}`;
    const hold: Hold = {
      owner,
      backend: store.configuration,
      roots: [],
      pid: process.pid,
      session,
      recordId: null,
    };
    state.saveHold(hold);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        store.registerOwner(owner, []);
        break;
      } catch (error) {
        if (
          (error as { code?: unknown }).code !== "retention_unfinished" ||
          Date.now() >= deadline
        ) {
          state.saveHold({ ...hold, pid: null });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return new Ownership(state, store, owner);
  }
  async retain(roots: string[], signal?: AbortSignal): Promise<void> {
    const current = this.state.hold(this.owner)!;
    const added = roots.filter((root) => !current.roots.includes(root));
    if (!added.length) return;
    await this.store.retain(this.owner, added, signal ? { signal } : {});
    // Read again after await: concurrent requests must not lose each other's references.
    const latest = this.state.hold(this.owner)!;
    this.state.saveHold({
      ...latest,
      roots: [...new Set([...latest.roots, ...added])],
    });
    await this.store.confirmRetained(
      this.owner,
      added,
      signal ? { signal } : {},
    );
  }
  async release(): Promise<void> {
    const hold = this.state.hold(this.owner);
    if (!hold) return;
    this.state.saveHold({ ...hold, roots: [] });
    try {
      if (hold.session) await this.store.discardImport(hold.session);
      await this.store.recoverOwner(
        this.owner,
        () => this.state.hold(this.owner)?.roots ?? [],
      );
      await this.store.reconcile(
        this.owner,
        () => this.state.hold(this.owner)?.roots ?? [],
      );
      this.state.deleteHold(this.owner);
    } catch (error) {
      const current = this.state.hold(this.owner);
      if (current) this.state.saveHold({ ...current, pid: null });
      throw error;
    }
  }
}

export type StoreFactory = (config: StoreConfiguration) => IpfsStore;
const createStore: StoreFactory = (config) => new IpfsStore(config);

export async function recoverInactive(
  state: State,
  factory: StoreFactory = createStore,
): Promise<void> {
  for (const hold of state.holds()) {
    if (hold.recordId || (hold.pid !== null && alive(hold.pid))) continue;
    const store = factory(hold.backend);
    try {
      await store.recoverOwner(
        hold.owner,
        () => state.hold(hold.owner)?.roots ?? [],
        {
          isIdle: () => {
            const current = state.hold(hold.owner);
            return !current || current.pid === null || !alive(current.pid);
          },
        },
      );
      const current = state.hold(hold.owner);
      if (current && (current.pid === null || !alive(current.pid))) {
        await new Ownership(state, store, hold.owner).release();
      }
    } finally {
      await store.close();
    }
  }
}

export async function saveHistory(
  state: State,
  store: IpfsStore,
  record: RunRecord,
  retained: boolean,
): Promise<void> {
  if (!retained || !record.outputCid) {
    state.saveRun(record);
    return;
  }
  const ownership = await Ownership.create(
    state,
    store,
    `history:${record.id}`,
    null,
  );
  record.retention = { owned: true, state: "pending", owner: ownership.owner };
  try {
    await store.retain(ownership.owner, [record.outputCid]);
    state.transaction(() => {
      const hold = state.hold(ownership.owner)!;
      state.saveHold({
        ...hold,
        roots: [record.outputCid!],
        recordId: record.id,
      });
      state.saveRun(record);
    });
    await store.confirmRetained(ownership.owner, [record.outputCid]);
    state.transaction(() => {
      record.retention.state = "retained";
      state.saveRun(record);
      state.saveHold({ ...state.hold(ownership.owner)!, pid: null });
    });
  } catch (error) {
    state.saveHold({ ...state.hold(ownership.owner)!, pid: null });
    throw error;
  }
}

export async function removeHistory(
  state: State,
  ids: readonly string[],
  factory: StoreFactory = createStore,
): Promise<{
  removed: string[];
  retentionClaimsReleased: true;
  garbageCollectionGuaranteed: false;
}> {
  const removed: string[] = [];
  for (const id of ids) {
    try {
      const record = state.run(id);
      if (record.retention.owned) {
        const hold = record.retention.owner
          ? state.hold(record.retention.owner)
          : undefined;
        if (!hold)
          throw new HostError(
            "Retention ownership metadata is missing; deletion is blocked.",
          );
        if (hold.pid !== null && alive(hold.pid))
          throw new HostError(
            "Record retention commit is active; retry after it finishes.",
          );
        const store = factory(hold.backend);
        try {
          state.transaction(() => {
            const latest = state.run(id);
            latest.retention.state = "releasing";
            state.saveRun(latest);
            state.saveHold({ ...hold, roots: [], pid: null });
          });
          // These callbacks read persisted references while the Store participant mutex is held.
          await store.recoverOwner(
            hold.owner,
            () => state.hold(hold.owner)?.roots ?? [],
          );
          await store.reconcile(
            hold.owner,
            () => state.hold(hold.owner)?.roots ?? [],
          );
          state.transaction(() => {
            state.deleteRun(id);
            state.deleteHold(hold.owner);
          });
        } finally {
          await store.close();
        }
      } else state.deleteRun(id);
      removed.push(id);
    } catch (error) {
      throw new HostError(
        `History removal incomplete. Completed: ${JSON.stringify(removed)}; remaining: ${JSON.stringify(
          ids.filter((target) => !removed.includes(target)),
        )}. ${message(error)} Ownership remains recoverable; no garbage collection requested.`,
        1,
        "RELEASE_FAILED",
        "cleanup",
      );
    }
  }
  return {
    removed,
    retentionClaimsReleased: true,
    garbageCollectionGuaranteed: false,
  };
}
