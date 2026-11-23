import { createInterface } from "node:readline/promises";
import { IpfsStore } from "@ipab/ipfs-store";
import { randomUUID } from "node:crypto";
import stringWidth from "string-width";
import {
  configKey,
  effectiveConfig,
  parseValue,
  publicUrl,
  stateLocation,
  storeConfiguration,
  type GlobalOptions,
} from "./config.js";
import { HostError, message, syntax } from "./errors.js";
import {
  filters,
  listHistory,
  selectedIds,
  Ownership,
  recoverInactive,
  removeHistory,
} from "./history.js";
import { execute } from "./runtime.js";
import { validatedBundle } from "./space.js";
import { State, type RunRecord } from "./state.js";

export interface IO {
  out(text: string): void;
  err(text: string): void;
  tty: boolean;
  columns?(): number | undefined;
  confirm(text: string): Promise<boolean>;
}
export const processIO: IO = {
  out(text) {
    process.stdout.write(`${text}\n`);
  },
  err(text) {
    process.stderr.write(`${text}\n`);
  },
  tty: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  columns() {
    return process.stdout.columns;
  },
  async confirm(text) {
    const reader = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return /^(y|yes)$/i.test(
        (await reader.question(`${text} [y/N] `)).trim(),
      );
    } finally {
      reader.close();
    }
  },
};
const commands: Record<string, string> = {
  exec: "exec APP [APP_ARGS...]",
  open: "open CONTENT",
  "alias list": "alias list",
  "alias set": "alias set NAME CID [--replace]",
  "alias remove": "alias remove NAME",
  "register list": "register list",
  "register set": "register set SCHEMA APP [--replace] [-- TEMPLATE...]",
  "register remove": "register remove SCHEMA",
  "config get": "config get [KEY]",
  "config set": "config set KEY VALUE",
  "config reset": "config reset KEY",
  "history list":
    "history list [--app APP] [--status STATUS] [--since TIME] [--until TIME] [--limit N] [--before RUN_ID]",
  "history show": "history show RUN_ID",
  "history remove":
    "history remove RUN_ID... [--yes]\n       ipab history remove FILTERS [--yes]",
};
export function help(path = ""): string {
  if (!path)
    return `IPAB — execute Apps and open content with an explicit IPFS context.
Usage: ipab [--state-dir PATH] [--store-rpc URL] [--json] COMMAND
Commands: exec, open, alias, register, config, history
Examples: ipab exec APP --help
          ipab register set SCHEMA APP
          ipab --json history list
--json is management-only. --version prints the version.
All nodes accept -h/--help. Global options precede COMMAND.
See README.md and docs/design-overview.md. Node Apps are NOT sandboxed.`;
  const usage = commands[path];
  if (usage)
    return `Usage: ipab [GLOBAL_OPTIONS] ${usage}
Example: ipab ${path === "exec" ? "exec APP --cid CID" : path === "open" ? "open CONTENT" : usage}
Use -h/--help for help. Global flags: --state-dir PATH, --store-rpc URL, --json (management only).
exec: everything after APP is verbatim argv; stdio is inherited.
history filters: AND, endedAt in [since,until), RFC3339 with timezone.
history remove: explicit IDs OR filters; non-TTY requires --yes; no GC guarantee.`;
  const leaves = Object.keys(commands).filter((key) =>
    key.startsWith(`${path} `),
  );
  if (!leaves.length) syntax(`Unknown command "${path}".`);
  return `Usage: ipab [GLOBAL_OPTIONS] ${path} COMMAND\nCommands: ${leaves.map((key) => key.slice(path.length + 1)).join(", ")}\nRun ipab ${leaves[0]} --help.`;
}
function printable(text: string): string {
  return [...text]
    .map((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
        ? JSON.stringify(char).slice(1, -1)
        : char,
    )
    .join("");
}

function abbreviated(text: string, limit: number): string {
  const characters = [...text];
  return characters.length <= limit
    ? text
    : `${characters.slice(0, limit - 3).join("")}...`;
}

function commandArguments(argv: readonly string[]): string {
  return (
    argv
      .map((argument) =>
        /^[A-Za-z0-9_./:@%=,+-]+$/.test(argument)
          ? argument
          : JSON.stringify(argument),
      )
      .join(" ") || "-"
  );
}

function fittedColumns(text: string, columns: number): string {
  if (stringWidth(text) <= columns) return text;
  let prefix = "";
  let width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text)) {
    const next = stringWidth(segment);
    if (width + next > columns - 3) break;
    prefix += segment;
    width += next;
  }
  return `${prefix}...`;
}

function endedDisplay(endedAt: string, now: number): string {
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(ended))
    throw new HostError("Execution record has an invalid end time.");
  const age = now - ended;
  if (age < 0 || age >= 86_400_000)
    return new Date(ended).toISOString().slice(0, 10);
  return age >= 3_600_000
    ? `${Math.floor(age / 3_600_000)}h`
    : `${Math.floor(age / 60_000)}m`;
}

function table(
  headers: string[],
  rows: string[][],
  empty: string,
  lastColumn?: { columns: number | undefined; fallbackCharacters: number },
): string {
  if (!rows.length) return empty;
  const cells = rows.map((row) => row.map(printable));
  const widths = headers.map((header, column) =>
    cells.reduce(
      (width, row) => Math.max(width, stringWidth(row[column]!)),
      stringWidth(header),
    ),
  );
  if (lastColumn) {
    const column = headers.length - 1;
    const columns = lastColumn.columns;
    if (
      columns !== undefined &&
      (!Number.isSafeInteger(columns) || columns <= 0)
    )
      throw new HostError("Invalid terminal width.");
    const available =
      columns === undefined
        ? undefined
        : Math.max(
            stringWidth(headers[column]!),
            columns -
              widths.slice(0, column).reduce((sum, width) => sum + width, 0) -
              column * 2,
          );
    for (const row of cells)
      row[column] =
        available === undefined
          ? abbreviated(row[column]!, lastColumn.fallbackCharacters)
          : fittedColumns(row[column]!, available);
  }
  return [headers, ...cells]
    .map((row) =>
      row
        .map((cell, column) =>
          column === headers.length - 1
            ? cell
            : cell.padEnd(cell.length + widths[column]! - stringWidth(cell)),
        )
        .join("  "),
    )
    .join("\n");
}

function runDetails(record: RunRecord): string {
  const fields: [string, string][] = [
    ["Run", record.id],
    ["Origin", record.origin],
    ["App CID", record.appCid],
    ["Argv", JSON.stringify(record.argv)],
    ["Started", record.startedAt],
    ["Ended", record.endedAt],
    ["Status", record.status],
    [
      "App exit",
      record.appExitCode === null ? "unavailable" : String(record.appExitCode),
    ],
    ["Output CID", record.outputCid ?? "none"],
    [
      "Retention",
      `${record.retention.state} (${record.retention.owned ? "record-owned" : "not record-owned"})`,
    ],
    [
      "Error",
      record.error
        ? `${record.error.phase}/${record.error.code}: ${record.error.message}`
        : "none",
    ],
  ];
  if (record.retention.owner)
    fields.push(["Retention owner", record.retention.owner]);
  return fields.map(([key, value]) => `${key}: ${printable(value)}`).join("\n");
}

interface Parsed {
  flags: GlobalOptions;
  path: string;
  positional: string[];
  options: Record<string, string | boolean>;
  template?: string[];
  help: boolean;
  version: boolean;
}

async function closeStore(
  store: IpfsStore | undefined,
  appExitCode: number | undefined,
): Promise<void> {
  try {
    await store?.close();
  } catch (error) {
    throw new HostError(
      `Store cleanup failed: ${message(error)}`,
      appExitCode || 1,
      "CLEANUP_FAILED",
      "cleanup",
    );
  }
}

export function parse(argv: readonly string[]): Parsed {
  const tokens = [...argv];
  const flags: GlobalOptions = { json: false };
  while (tokens[0]?.startsWith("-")) {
    const flag = tokens.shift()!;
    if (flag === "-h" || flag === "--help")
      return {
        flags,
        path: "",
        positional: [],
        options: {},
        help: true,
        version: false,
      };
    if (flag === "--version") {
      if (tokens.length) syntax("--version does not accept a command.");
      return {
        flags,
        path: "",
        positional: [],
        options: {},
        help: false,
        version: true,
      };
    }
    if (flag === "--json") flags.json = true;
    else if (flag === "--state-dir" || flag === "--store-rpc") {
      const value = tokens.shift();
      if (!value || value.startsWith("-")) syntax(`${flag} needs a value.`);
      if (flag === "--state-dir") flags.stateDir = value;
      else {
        flags.storeRpc = publicUrl(value);
      }
    } else syntax(`Unknown global option "${flag}".`);
  }
  const group = tokens.shift() ?? "";
  const result: Parsed = {
    flags,
    path: group,
    positional: [],
    options: {},
    help: !group,
    version: false,
  };
  if (!group) return result;
  if (group === "exec") {
    if (flags.json) syntax("--json is not supported for exec/open.");
    if (tokens[0] === "-h" || tokens[0] === "--help") {
      result.help = true;
      return result;
    }
    if (!tokens.length || tokens[0]!.startsWith("-"))
      syntax(`Expected APP.\n${help("exec")}`);
    result.positional = tokens;
    return result;
  }
  if (group !== "open") {
    if (!["alias", "register", "config", "history"].includes(group))
      syntax(`Unknown command "${group}".`);
    if (!tokens.length || tokens[0] === "-h" || tokens[0] === "--help") {
      result.help = true;
      return result;
    }
    result.path = `${group} ${tokens.shift()!}`;
  } else if (flags.json) syntax("--json is not supported for exec/open.");
  if (!commands[result.path]) syntax(`Unknown command "${result.path}".`);
  const separator = result.path === "register set" ? tokens.indexOf("--") : -1;
  if (separator >= 0) result.template = tokens.splice(separator + 1);
  if (separator >= 0) tokens.splice(separator);
  if (tokens.includes("-h") || tokens.includes("--help")) {
    result.help = true;
    return result;
  }
  const booleans =
    result.path === "alias set" || result.path === "register set"
      ? ["replace"]
      : result.path === "history remove"
        ? ["yes"]
        : [];
  const values =
    result.path === "history list"
      ? ["app", "status", "since", "until", "limit", "before"]
      : result.path === "history remove"
        ? ["app", "status", "since", "until"]
        : [];
  while (tokens.length) {
    const value = tokens.shift()!;
    if (value.startsWith("--")) {
      const option = value.slice(2);
      if (Object.hasOwn(result.options, option))
        syntax(`Duplicate option ${value}.`);
      if (booleans.includes(option)) result.options[option] = true;
      else if (values.includes(option)) {
        const input = tokens.shift();
        if (!input || input.startsWith("--")) syntax(`${value} needs a value.`);
        result.options[option] = input;
      } else syntax(`Unknown option "${value}".`);
    } else result.positional.push(value);
  }
  const counts: Record<string, [number, number]> = {
    open: [1, 1],
    "alias list": [0, 0],
    "alias set": [2, 2],
    "alias remove": [1, 1],
    "register list": [0, 0],
    "register set": [2, 2],
    "register remove": [1, 1],
    "config get": [0, 1],
    "config set": [2, 2],
    "config reset": [1, 1],
    "history list": [0, 0],
    "history show": [1, 1],
    "history remove": [0, Number.MAX_SAFE_INTEGER],
  };
  const [minimum, maximum] = counts[result.path]!;
  if (result.positional.length < minimum || result.positional.length > maximum)
    syntax(`Invalid arguments.\n${help(result.path)}`);
  if (
    result.template &&
    (!result.template.length || !result.template.includes("%"))
  )
    syntax('Argument template must contain a whole "%" token.');
  if (result.path === "history remove") {
    const selected = values.some((value) =>
      Object.hasOwn(result.options, value),
    );
    if (
      (!selected && !result.positional.length) ||
      (selected && result.positional.length)
    )
      syntax("history remove requires explicit IDs OR filters, not both.");
  }
  // Validate syntactic values before state access, let alone a backend connection.
  if (result.path.startsWith("config ") && result.positional[0]) {
    if (!(result.path === "config get" && result.positional[0] === "state-dir"))
      configKey(result.positional[0]);
    if (result.path === "config set")
      parseValue(configKey(result.positional[0]), result.positional[1], true);
  }
  if (typeof result.options.limit === "string")
    parseValue("history.limit", result.options.limit, true);
  return result;
}

async function performCli(
  argv: readonly string[],
  io: IO,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let state: State | undefined;
  let store: IpfsStore | undefined;
  let appExitCode: number | undefined;
  try {
    const parsed = parse(argv);
    if (parsed.help) {
      io.out(help(parsed.path));
      return 0;
    }
    if (parsed.version) {
      io.out("0.0.0");
      return 0;
    }
    if (parsed.path === "history remove" && !parsed.options.yes && !io.tty)
      syntax("Non-interactive history remove requires --yes.");
    state = new State(stateLocation(parsed.flags, env).path);
    const items = effectiveConfig(state.config(), parsed.flags, env);
    const value = (key: string) =>
      items.find((item) => item.key === key)!.value;
    const emit = (result: unknown, human: string) => {
      io.out(parsed.flags.json ? JSON.stringify(result) : human);
    };
    const [first, second] = parsed.positional;
    const filter = parsed.path.startsWith("history ")
      ? filters(state, parsed.options)
      : {};
    switch (parsed.path) {
      case "alias list": {
        const aliases = state.aliases();
        emit(
          { items: aliases },
          table(
            ["NAME", "CID"],
            aliases.map((alias) => [alias.name, alias.cid]),
            "No aliases.",
          ),
        );
        break;
      }
      case "alias set": {
        const result = state.setAlias(
          first!,
          second!,
          Boolean(parsed.options.replace),
        );
        emit(result, `${result.name} → ${result.cid}`);
        break;
      }
      case "alias remove":
        state.removeAlias(first!);
        emit({ removed: [first] }, `Removed ${first}.`);
        break;
      case "register list": {
        const associations = state.registrations();
        emit(
          { items: associations },
          table(
            ["SCHEMA CID", "APP CID", "ARGV"],
            associations.map((association) => [
              association.schemaCid,
              association.appCid,
              JSON.stringify(association.argv),
            ]),
            "No associations.",
          ),
        );
        break;
      }
      case "register set": {
        const association = state.setAssociation(
          first!,
          second!,
          parsed.template ?? ["%"],
          Boolean(parsed.options.replace),
        );
        emit(
          association,
          `${association.schemaCid} → ${association.appCid} ${JSON.stringify(association.argv)}`,
        );
        break;
      }
      case "register remove": {
        const removed = state.removeAssociation(first!);
        emit({ removed: [removed] }, `Removed association for ${removed}.`);
        break;
      }
      case "config get": {
        const selected = first
          ? items.filter((item) => item.key === first)
          : items;
        emit(
          { items: selected },
          table(
            ["KEY", "VALUE", "SOURCE"],
            selected.map((item) => [item.key, String(item.value), item.source]),
            "No configuration values.",
          ),
        );
        break;
      }
      case "config set": {
        const key = configKey(first!);
        const saved = parseValue(key, second, true);
        state.setConfig(key, saved);
        const source = items.find((item) => item.key === key)!.source;
        if (source === "env" || source === "flag")
          io.err(`Warning: saved user value is masked by ${source}.`);
        emit(
          { key, value: saved, source: "user" },
          `Saved ${key} = ${printable(String(saved))} (user).`,
        );
        break;
      }
      case "config reset":
        state.resetConfig(configKey(first!));
        emit({ reset: [first] }, `Reset user override: ${first}.`);
        break;
      case "history list": {
        const page = listHistory(
          state,
          filter,
          Number(parsed.options.limit ?? value("history.limit")),
          typeof parsed.options.before === "string"
            ? state.resolveRunId(parsed.options.before)
            : undefined,
        );
        if (parsed.flags.json) {
          emit(page, "");
          break;
        }
        const aliases = new Map<string, string>();
        for (const alias of state.aliases())
          if (!aliases.has(alias.cid)) aliases.set(alias.cid, alias.name);
        const reference = (cid: string | null): string =>
          cid === null ? "none" : abbreviated(aliases.get(cid) ?? cid, 16);
        const shortId = state.shortRunId.bind(state);
        const now = Date.now();
        const rows = table(
          ["RUN ID", "ENDED", "STATUS", "APP", "OUTPUT", "ARGV"],
          page.items.map((record) => [
            shortId(record.id),
            endedDisplay(record.endedAt, now),
            record.status,
            reference(record.appCid),
            reference(record.outputCid),
            commandArguments(record.argv),
          ]),
          "No ended executions.",
          { columns: io.columns?.(), fallbackCharacters: 48 },
        );
        emit(
          page,
          rows +
            (page.nextBefore
              ? `\nMore matches; use --before ${shortId(page.nextBefore)} with the same filters.`
              : ""),
        );
        break;
      }
      case "history show": {
        const record = state.run(state.resolveRunId(first!));
        emit(record, runDetails(record));
        break;
      }
      case "history remove": {
        const ids = parsed.positional.length
          ? [...new Set(parsed.positional.map(state.resolveRunId.bind(state)))]
          : selectedIds(state, filter);
        for (const id of ids) state.run(id);
        if (
          ids.length &&
          !parsed.options.yes &&
          !(await io.confirm(
            `Remove ${ids.length} ended records selected by ${JSON.stringify(
              parsed.positional.length ? { ids } : parsed.options,
            )}? Release only their retention; no GC or disk reclamation is guaranteed.`,
          ))
        )
          throw new HostError("History removal cancelled.");
        const result = await removeHistory(state, ids);
        emit(
          result,
          `Removed ${result.removed.length} records; garbage collection is not guaranteed.`,
        );
        break;
      }
      case "exec":
      case "open": {
        const target = state.resolve(first!);
        await recoverInactive(state);
        store = new IpfsStore(await storeConfiguration(value("store.rpc")));
        let appCid: string;
        let appArgv: string[];
        if (parsed.path === "open") {
          const root = target;
          const owner = await Ownership.create(
            state,
            store,
            `open:${randomUUID()}`,
            null,
          );
          try {
            const content = await validatedBundle(root, store, owner);
            const schema = content.manifest.entry.schemaCid.toV1().toString();
            const association = state.association(schema);
            if (!association)
              throw new HostError(
                `No App registered for Schema ${schema}. Use ipab register set or ipab exec.`,
              );
            appCid = association.appCid;
            appArgv = association.argv.map((argument) =>
              argument === "%" ? root : argument,
            );
            // execute owns the App/input context before this validation owner's eventual release.
            const result = await execute(
              state,
              store,
              { origin: "open", appCid, argv: appArgv },
              {
                history: Boolean(value("history.enabled")),
                retain: value("output.retention") === "history",
                diagnostic: (text) => {
                  io.err(text);
                },
              },
            );
            appExitCode = result.exitCode;
            return appExitCode;
          } finally {
            await owner.release();
          }
        } else {
          appCid = target;
          appArgv = parsed.positional.slice(1);
        }
        appExitCode = (
          await execute(
            state,
            store,
            { origin: "exec", appCid, argv: appArgv },
            {
              history: Boolean(value("history.enabled")),
              retain: value("output.retention") === "history",
              diagnostic: (text) => {
                io.err(text);
              },
            },
          )
        ).exitCode;
        return appExitCode;
      }
      default:
        syntax("Unknown command.");
    }
    return 0;
  } catch (error) {
    io.err(`Error: ${message(error)}`);
    return error instanceof HostError ? error.exitCode : 1;
  } finally {
    try {
      await closeStore(store, appExitCode);
    } finally {
      state?.close();
    }
  }
}

export async function runCli(
  argv: readonly string[],
  io: IO = processIO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    return await performCli(argv, io, env);
  } catch (error) {
    io.err(`Error: ${message(error)}`);
    return error instanceof HostError ? error.exitCode : 1;
  }
}
