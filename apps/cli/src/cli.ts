import { createInterface } from "node:readline/promises";
import { IpfsStore } from "@ipab/ipfs-store";
import { randomUUID } from "node:crypto";
import type { CID } from "multiformats/cid";
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
import { exactCid, pinName, State, type RunRecord } from "./state.js";
import {
  buildBundle,
  initBundle,
  inspectBundle,
  importBundle,
} from "./authoring.js";
import { buildApp, initApp } from "./app-authoring.js";
import { schemaAlias } from "./app-definition.js";
import { addPin, deletePin, pinDetails, renamePin } from "./pins.js";

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
  init: "init NAME [DIR]",
  build: "build [DIR] [-o FILE | --output FILE] [--replace] [--no-import]",
  "bundle init": "bundle init TYPE DIR",
  "bundle build":
    "bundle build SOURCE [--schema-only] [-o FILE | --output FILE] [--replace] [--no-import]",
  "bundle inspect": "bundle inspect SOURCE",
  "bundle import": "bundle import FILE.car",
  exec: "exec APP [APP_ARGS...]",
  open: "open CONTENT",
  "pin add": "pin add NAME CID",
  "pin delete": "pin delete NAME",
  "pin list": "pin list [--kind bundle|schema] [--type TYPE]",
  "pin show": "pin show NAME",
  "pin rename": "pin rename OLD_NAME NEW_NAME",
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
Commands: init, build, bundle, exec, open, pin, register, config, history
Examples: ipab init hello
          ipab build hello
          ipab pin add reader CID
          ipab exec APP --help
          ipab register set SCHEMA APP
          ipab --json history list
--json returns management/development metadata, never App stdio. --version prints the version.
All nodes accept -h/--help. Global options precede COMMAND.
See README.md and docs/design-overview.md. Node Apps are NOT sandboxed.`;
  const usage = commands[path];
  if (path === "init" || path === "build")
    return `Usage: ipab [GLOBAL_OPTIONS] ${usage}
Examples: ipab init hello
          ipab init hello .\\projects\\hello
          ipab --json build hello --replace
init creates a private TypeScript npm package in NAME or explicit DIR (new/empty only).
Install the generated package's dependencies explicitly; use a locally linked ipab.
build defaults to the current project: strict local tsc, bundled Node CommonJS, App CAR.
ipab.yaml selects src/main.ts, explicit assets/ resources and schemas/ JSON definitions.
The commented init template teaches icon placement, name/description i18n and metadata.
Legacy ipab.json is accepted only when ipab.yaml is absent; keep exactly one config.
supportedSchemas controls exact type support for open, not argv or direct exec.
Default output is dist/app.car.
--output FILE selects a .car destination; --replace replaces only a regular artifact.
build imports the result into the configured Store without pinning; --no-import emits only CAR.
Store failures fail the command but preserve the CAR; retry with bundle import FILE.car.
No npm hooks, installs, execution or pins. --json emits result metadata, including imported for builds.
Global flags precede COMMAND. Use -h/--help for help.`;
  if (usage && path.startsWith("bundle ")) {
    if (path === "bundle import")
      return `Usage: ipab [GLOBAL_OPTIONS] ${usage}
Example: ipab bundle import hello\\dist\\app.car
Validates a self-contained single-root Bundle or type CAR before writing to the configured Store.
Uses the default local Store or explicit Kubo RPC; no daemon is started.
Writes original blocks without pinning or retaining; repeated imports are safe.
Does not execute Apps or change named pins/register. Unpinned blocks may be garbage-collected externally.
--json emits kind, cid, schemaCid, source, blocks and bytes; progress goes to stderr.
Global flags precede COMMAND. Use -h/--help for help.`;
    const examples =
      path === "bundle init"
        ? "ipab bundle init types\\dist\\schema.car note"
        : path === "bundle build"
          ? "ipab bundle build note\n         ipab bundle build types\\.bundle.yaml --schema-only"
          : "ipab bundle inspect note\\dist\\bundle.car";
    return `Usage: ipab [GLOBAL_OPTIONS] ${usage}
Example: ${examples}
Global flags precede COMMAND: --state-dir PATH, --store-rpc URL, --json.
TYPE is a complete definition file, type CAR, exact type CID or builtin:node-app.v1; local sources need no Store.
build --schema-only validates defaults and emits dist/schema.car; full build emits dist/bundle.car.
build imports the result into the configured Store without pinning; --no-import emits only CAR.
--output FILE overrides the destination; --replace authorizes replacing an artifact, never source.
init writes .bundle.yaml, .bundle-ignore (/dist/) and the default entry into a new/empty directory.
inspect reads a folder, definition, CAR or CID; no App execution, uploads, imports or pins.
Use -h/--help for help.`;
  }
  if (usage && path.startsWith("pin "))
    return `Usage: ipab [GLOBAL_OPTIONS] ${usage}
Examples: ipab pin add reader APP_CID
          ipab pin list --kind bundle --type builtin:node-app.v1
          ipab pin rename reader my-reader
Global flags precede COMMAND: --state-dir PATH, --store-rpc URL, --json.
add requires an unused short name and an exact CID; verifies the full DAG and retains it in the configured Store.
Pinning does not execute or trust an App, install dependencies, or start a daemon.
delete releases only this pin's ownership on its original backend; no block deletion or GC.
rename changes only the name, not the CID, type metadata, registration, history or ownership.
list/show read local registration, not live node status; list excludes builtin shortcuts and reports unfinished operations separately.
--kind accepts bundle or schema; ordinary content remains visible without a kind filter.
--type matches exact schema CID (or Schema pin name/builtin shortcut); filters combine with AND.
User Alias commands are replaced; legacy metadata is preserved but requires explicit verified pin add.
Use -h/--help for help.`;
  if (usage)
    return `Usage: ipab [GLOBAL_OPTIONS] ${usage}
Example: ipab ${path === "exec" ? "exec APP --cid CID" : path === "open" ? "open CONTENT" : usage}
Use -h/--help for help. Global flags: --state-dir PATH, --store-rpc URL, --json (metadata only).
exec: everything after APP is verbatim argv; stdio is inherited.
history filters: AND, endedAt in [since,until), RFC3339 with timezone.
register set/remove SCHEMA accepts builtin:node-app.v1 offline and stores its exact type CID.
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
  if (!["open", "init", "build"].includes(group)) {
    if (!["bundle", "pin", "register", "config", "history"].includes(group))
      syntax(`Unknown command "${group}".`);
    if (!tokens.length || tokens[0] === "-h" || tokens[0] === "--help") {
      result.help = true;
      return result;
    }
    result.path = `${group} ${tokens.shift()!}`;
  } else if (group === "open" && flags.json)
    syntax("--json is not supported for exec/open.");
  if (!commands[result.path]) syntax(`Unknown command "${result.path}".`);
  const separator = result.path === "register set" ? tokens.indexOf("--") : -1;
  if (separator >= 0) result.template = tokens.splice(separator + 1);
  if (separator >= 0) tokens.splice(separator);
  if (tokens.includes("-h") || tokens.includes("--help")) {
    result.help = true;
    return result;
  }
  const booleans =
    result.path === "bundle build"
      ? ["replace", "schema-only", "no-import"]
      : result.path === "build"
        ? ["replace", "no-import"]
        : result.path === "register set"
          ? ["replace"]
          : result.path === "history remove"
            ? ["yes"]
            : [];
  const values =
    result.path === "bundle build" || result.path === "build"
      ? ["output"]
      : result.path === "history list"
        ? ["app", "status", "since", "until", "limit", "before"]
        : result.path === "history remove"
          ? ["app", "status", "since", "until"]
          : result.path === "pin list"
            ? ["kind", "type"]
            : [];
  while (tokens.length) {
    const value = tokens.shift()!;
    if (value.startsWith("--") || value === "-o") {
      const option = value === "-o" ? "output" : value.slice(2);
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
    init: [1, 2],
    build: [0, 1],
    "bundle init": [2, 2],
    "bundle build": [1, 1],
    "bundle inspect": [1, 1],
    "bundle import": [1, 1],
    open: [1, 1],
    "pin add": [2, 2],
    "pin delete": [1, 1],
    "pin list": [0, 0],
    "pin show": [1, 1],
    "pin rename": [2, 2],
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
  if (result.path.startsWith("pin ") && result.path !== "pin list") {
    pinName(result.positional[0]!);
    if (result.path === "pin add") exactCid(result.positional[1]!);
    if (result.path === "pin rename") pinName(result.positional[1]!);
  }
  if (
    result.options.kind !== undefined &&
    !["bundle", "schema"].includes(String(result.options.kind))
  )
    syntax("--kind must be bundle or schema.");
  if (result.path.startsWith("config ") && result.positional[0]) {
    if (!(result.path === "config get" && result.positional[0] === "state-dir"))
      configKey(result.positional[0]);
    if (result.path === "config set")
      parseValue(configKey(result.positional[0]), result.positional[1], true);
  }
  if (typeof result.options.limit === "string")
    parseValue("history.limit", result.options.limit, true);
  if (result.options.output === "-")
    syntax("CAR output requires a file path; binary stdout is not supported.");
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
      case "init":
      case "build":
      case "bundle init":
      case "bundle build":
      case "bundle inspect":
      case "bundle import": {
        const controller = new AbortController();
        let cancelled = 0;
        const interrupt = () => {
          cancelled = 130;
          controller.abort(new Error("Interrupted."));
        };
        const terminate = () => {
          cancelled = 143;
          controller.abort(new Error("Terminated."));
        };
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", terminate);
        try {
          let pendingStore: Promise<IpfsStore> | undefined;
          const getStore = () => {
            pendingStore ??= storeConfiguration(value("store.rpc")).then(
              (configuration) => {
                store = new IpfsStore(configuration);
                return store;
              },
            );
            return pendingStore;
          };
          const request = {
            signal: controller.signal,
            resolveCid: async (cid: CID, options: { signal?: AbortSignal }) => {
              return (await getStore()).block.get(cid.toString(), options);
            },
          };
          if (parsed.path === "bundle build" || parsed.path === "build")
            io.err(
              parsed.path === "build"
                ? "Typechecking, bundling and building App..."
                : "Validating and building bundle...",
            );
          if (parsed.path === "bundle import")
            io.err("Validating and importing CAR into Store...");
          const result =
            parsed.path === "init"
              ? await initApp(first!, second, request)
              : parsed.path === "build"
                ? await buildApp(first, {
                    ...request,
                    replace: Boolean(parsed.options.replace),
                    ...(typeof parsed.options.output === "string"
                      ? { output: parsed.options.output }
                      : {}),
                    outputDir: String(value("bundle.outputDir")),
                  })
                : parsed.path === "bundle init"
                  ? await initBundle(first!, second!, request)
                  : parsed.path === "bundle build"
                    ? await buildBundle(first!, {
                        ...request,
                        schemaOnly: Boolean(parsed.options["schema-only"]),
                        replace: Boolean(parsed.options.replace),
                        ...(typeof parsed.options.output === "string"
                          ? { output: parsed.options.output }
                          : {}),
                        outputDir: String(value("bundle.outputDir")),
                      })
                    : parsed.path === "bundle import"
                      ? await importBundle(first!, getStore, request)
                      : await inspectBundle(first!, request);
          const importing = "output" in result && !parsed.options["no-import"];
          if (importing) {
            io.err("Importing build result into Store (without pinning)...");
            try {
              await importBundle(result.output, getStore, request);
            } catch (cause) {
              throw new HostError(
                `${message(cause)} CAR remains at ${JSON.stringify(result.output)}; retry with ipab bundle import ${JSON.stringify(result.output)}, or build with --no-import.`,
                1,
                "IMPORT_FAILED",
                "authoring",
              );
            }
          }
          const closing = store;
          store = undefined;
          await closeStore(closing, undefined);
          state.close();
          state = undefined;
          controller.signal.throwIfAborted();
          if ("output" in result)
            emit(
              { ...result, imported: importing },
              `CID: ${result.cid}\nSchema CID: ${result.schemaCid}\nCAR: ${result.output}\nStore: ${importing ? "imported (not pinned)" : "not imported (--no-import)"}`,
            );
          else if (result.kind === "bundle-import")
            emit(
              result,
              `Imported CID: ${result.cid}\nSchema CID: ${result.schemaCid}\nBlocks: ${result.blocks}\nCAR: ${result.source}`,
            );
          else if (result.kind === "app-init") {
            emit(
              result,
              `Created App project: ${result.directory}\nSchema CID: ${result.schemaCid}`,
            );
            io.err(
              `Next: install declared dependencies in ${JSON.stringify(result.directory)}; then ipab build ${JSON.stringify(result.directory)} (requires locally linked ipab).`,
            );
          } else if ("directory" in result) {
            emit(
              result,
              `Created: ${result.directory}\nSchema CID: ${result.schemaCid}\nEntry: ${result.entry.path} (${result.entry.contentType})`,
            );
            io.err(
              `Next: ipab bundle build ${JSON.stringify(result.directory)}`,
            );
          } else
            emit(
              result,
              `Kind: ${result.kind}\nName: ${printable(result.name)}\nSchema CID: ${result.schemaCid}\nEntry: ${result.entry.path} (${result.entry.contentType})\nValidation: passed`,
            );
        } catch (cause) {
          if (cancelled)
            throw new HostError(
              message(cause),
              cancelled,
              "ABORTED",
              "authoring",
            );
          throw cause;
        } finally {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", terminate);
        }
        break;
      }
      case "pin list": {
        if (typeof parsed.options.type === "string") {
          const named = state.pin(parsed.options.type);
          if (named && pinDetails(named).kind !== "schema")
            throw new HostError(
              "--type short names must identify a Schema pin.",
            );
        }
        const type =
          typeof parsed.options.type === "string"
            ? state.resolve(schemaAlias(parsed.options.type), true)
            : undefined;
        const pins = state.pins();
        const listed = pins
          .filter((pin) => pin.status === "ready")
          .map(pinDetails)
          .filter(
            (pin) =>
              (!parsed.options.kind || pin.kind === parsed.options.kind) &&
              (type === undefined || pin.schemaCid === type),
          );
        const pending = pins
          .filter((pin) => pin.status !== "ready")
          .map(({ name, cid, status }) => ({ name, cid, status }));
        const legacyAliases = state.aliases();
        if (pending.length)
          io.err(
            `Unfinished pin operations (not usable pins): ${JSON.stringify(pending)}. Retry pin add/delete.`,
          );
        if (legacyAliases.length)
          io.err(
            "Legacy Alias metadata is preserved but is not pinned. Use the listed exact CIDs with pin add to migrate.",
          );
        emit(
          { items: listed, pending, legacyAliases },
          table(
            ["NAME", "CID", "KIND", "BUNDLE TYPE"],
            listed.map((pin) => [
              pin.name,
              pin.cid,
              pin.kind,
              pin.typeName ?? "(no Bundle type metadata)",
            ]),
            "No named pins.",
          ) +
            (legacyAliases.length
              ? `\nLegacy Aliases (not pinned):\n${table(
                  ["NAME", "CID"],
                  legacyAliases.map((alias) => [alias.name, alias.cid]),
                  "",
                )}`
              : ""),
        );
        break;
      }
      case "pin add": {
        io.err("Fetching, verifying and retaining content in Store...");
        const result = await addPin(
          state,
          first!,
          second!,
          await storeConfiguration(value("store.rpc")),
        );
        emit(
          result,
          `${result.name} → ${result.cid}\nKind: ${result.kind}\nBundle type: ${printable(result.typeName ?? "(no Bundle type metadata)")}`,
        );
        break;
      }
      case "pin delete": {
        const result = await deletePin(state, first!);
        emit(
          result,
          `Deleted ${first}; released only its retention responsibility. No blocks deleted or GC requested.`,
        );
        break;
      }
      case "pin show": {
        const pin = state.pin(first!);
        if (!pin)
          throw new HostError(
            `Pin "${first}" does not exist. Run ipab pin list.`,
          );
        const result = pinDetails(pin);
        emit(
          result,
          `Name: ${printable(result.name)}\nCID: ${result.cid}\nKind: ${result.kind}\nBundle type: ${printable(result.typeName ?? "(no Bundle type metadata)")}${result.schemaCid ? `\nSchema CID: ${result.schemaCid}` : ""}\nSource: local registration (not live node verification)`,
        );
        break;
      }
      case "pin rename": {
        const result = renamePin(state, first!, second!);
        emit(result, `${first} → ${result.name} (${result.cid})`);
        break;
      }
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
          schemaAlias(first!),
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
        const removed = state.removeAssociation(schemaAlias(first!));
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
        const names = new Map<string, string>();
        for (const pin of state.pins())
          if (pin.status === "ready" && !names.has(pin.cid))
            names.set(pin.cid, pin.name);
        const reference = (cid: string | null): string =>
          cid === null ? "none" : abbreviated(names.get(cid) ?? cid, 16);
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
            const schema = content.schemaKey;
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
                inputSchema: schema,
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
