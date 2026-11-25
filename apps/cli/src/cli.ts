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
import { logFiles } from "./logs.js";
import { builtinContent } from "./builtins.js";

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
  init: "init NAME [DIR] [OPTIONS]",
  build: "build [DIR] [OPTIONS]",
  "bundle init": "bundle init TYPE DIR",
  "bundle build": "bundle build SOURCE [OPTIONS]",
  "bundle inspect": "bundle inspect SOURCE",
  "bundle import": "bundle import FILE.car",
  exec: "exec [--log] APP [APP_ARGS...]",
  open: "open [--log] CONTENT",
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
  "history list": "history list [OPTIONS]",
  "history show": "history show RUN_ID",
  "history remove":
    "history remove RUN_ID... [--yes]\n       ipab history remove FILTERS [--yes]",
};
const groups: Record<string, string> = {
  bundle: "Create, inspect and import content bundles",
  pin: "Retain content and manage short names",
  register: "Associate content types with Apps",
  config: "Manage local configuration",
  history: "View and remove execution history",
};
const commandHelp: Record<
  string,
  {
    summary: string;
    examples: string[];
    arguments?: string[];
    options?: string[];
    notes?: string[];
  }
> = {
  init: {
    summary: "Create a private TypeScript App project",
    arguments: ["NAME  Project name; DIR defaults to NAME (new/empty only)."],
    options: [
      "--template TEMPLATE  node (default), web-app, directory, CAR, CID or pin.",
      "--param KEY=VALUE    Template parameter; repeatable. Strings are literal;",
      "                     other parameter types use JSON.",
    ],
    examples: [
      "ipab init hello",
      "ipab init dashboard --template web-app",
      "ipab init hello --param description=Demo",
    ],
    notes: ["Does not install dependencies or execute template code."],
  },
  build: {
    summary: "Build an App CAR from a project",
    arguments: ["DIR  Project directory (default: current directory)."],
    options: [
      "-o, --output FILE  Destination (default: dist/app.car).",
      "--replace         Allow replacing existing regular artifacts.",
      "--no-import       Write CAR files without importing the App into Store.",
      "--with-source     Include a separate source CAR (default: enabled).",
      "--without-source  Omit source CAR; conflicts with --with-source.",
    ],
    examples: ["ipab build", "ipab build hello --replace --without-source"],
    notes: [
      "Uses local tsc and bundles Node CommonJS; ipab.yaml configures the build.",
      "Explicit ipab-prebuild strategy executes trusted project code.",
      "Source follows project .gitignore rules; review private files before sharing.",
      "Imports only the App, without pinning; source needs separate import/retention.",
      "Store failures preserve the CAR; retry with ipab bundle import FILE.car.",
    ],
  },
  "bundle init": {
    summary: "Create content from a Bundle type",
    arguments: [
      "TYPE  Definition file, type CAR, exact type CID or Schema pin.",
      "DIR   New or empty destination directory.",
    ],
    examples: ["ipab bundle init types\\dist\\schema.car note"],
    notes: ["Writes .bundle.yaml, .bundle-ignore and the default entry."],
  },
  "bundle build": {
    summary: "Build a content or type CAR without compiling code",
    arguments: ["SOURCE  Bundle directory or definition file."],
    options: [
      "--schema-only     Emit only the type CAR (default: dist/schema.car).",
      "-o, --output FILE  Destination (full build default: dist/bundle.car).",
      "--replace         Allow replacing an existing regular artifact.",
      "--no-import       Write the CAR without importing it into Store.",
    ],
    examples: [
      "ipab bundle build note",
      "ipab bundle build types\\.bundle.yaml --schema-only",
    ],
    notes: [
      "Imports into the configured Store without pinning or executing Apps.",
      "Store failures preserve the CAR; retry with ipab bundle import FILE.car.",
    ],
  },
  "bundle inspect": {
    summary: "Inspect a Bundle or type definition",
    arguments: ["SOURCE  Directory, definition file, CAR, CID or named pin."],
    examples: ["ipab bundle inspect note\\dist\\bundle.car"],
    notes: ["Does not execute Apps, import content or create pins."],
  },
  "bundle import": {
    summary: "Validate and import a CAR into the configured Store",
    arguments: ["FILE.car  Self-contained single-root Bundle or type CAR."],
    examples: ["ipab bundle import hello\\dist\\app.car"],
    notes: [
      "Repeated imports are safe; no App execution or daemon startup.",
      "Does not pin or retain content. Use pin add for persistent retention.",
    ],
  },
  exec: {
    summary: "Run an App by CID or named pin",
    arguments: [
      "APP_ARGS  Everything after APP is passed verbatim, including --help.",
    ],
    options: [
      "--log  Record stdout/stderr; must precede APP. Requires history enabled.",
    ],
    examples: [
      "ipab exec reader",
      "ipab exec reader --help",
      "ipab exec --log reader",
    ],
    notes: [
      "Apps are NOT sandboxed; run only Apps you trust.",
      "History stores argv by default; do not put secrets in arguments.",
      "Logs may contain secrets; stdin is never logged. Logging makes output non-TTY.",
      "--json is not supported; App stdio is passed through.",
    ],
  },
  open: {
    summary: "Open content with its registered App",
    arguments: ["CONTENT  Bundle CID or named pin."],
    options: ["--log  Record stdout/stderr; requires history enabled."],
    examples: ["ipab open CONTENT_CID", "ipab open --log my-note"],
    notes: [
      "Requires a saved registration and App support for the exact content type.",
      "Apps are NOT sandboxed; run only Apps you trust.",
      "Logs may contain secrets; stdin is never logged. Logging makes output non-TTY.",
      "--json is not supported; App stdio is passed through.",
    ],
  },
  "pin add": {
    summary: "Verify, retain and name content",
    arguments: [
      "NAME  Unused short name.",
      "CID   Exact content CID, not another pin name.",
    ],
    examples: ["ipab pin add reader APP_CID"],
    notes: [
      "Verifies the full DAG and retains it in the configured Store.",
      "Does not execute or trust Apps, install dependencies or start a daemon.",
      "The builtin namespace is read-only.",
    ],
  },
  "pin delete": {
    summary: "Remove a user pin and release its retention",
    examples: ["ipab pin delete reader"],
    notes: [
      "Releases only this pin's ownership on its original backend; no block deletion or GC.",
      "Does not change registrations or history. Built-in pins are read-only.",
    ],
  },
  "pin list": {
    summary: "List user and built-in pins",
    options: [
      "--kind bundle|schema  Filter by kind; omit to include ordinary content.",
      "--type TYPE           Exact schema CID, Schema pin or builtin shortcut.",
    ],
    examples: [
      "ipab pin list",
      "ipab pin list --kind bundle --type builtin:node-app.v1",
    ],
    notes: [
      "Filters combine with AND. Unfinished user operations are reported separately.",
      "Reads local registrations and packaged built-ins, not live node status.",
    ],
  },
  "pin show": {
    summary: "Show a pin's CID and type metadata",
    examples: ["ipab pin show reader", "ipab pin show builtin:template.node"],
    notes: [
      "Reads local metadata; built-in pins do not claim user Store retention.",
    ],
  },
  "pin rename": {
    summary: "Rename a user pin without changing its content",
    examples: ["ipab pin rename reader my-reader"],
    notes: [
      "NEW_NAME must be unused. Built-in pins are read-only.",
      "CID, ownership, registrations and history are unchanged.",
    ],
  },
  "register list": {
    summary: "List saved content-type associations",
    examples: ["ipab register list"],
  },
  "register set": {
    summary: "Associate a content type with an App",
    arguments: [
      "SCHEMA    Exact type CID or builtin:node-app.v1.",
      "APP       App CID or named pin; the exact CID is saved.",
      "TEMPLATE  App argv after --; must contain a whole argument % (default: %).",
    ],
    options: ["--replace  Allow changing an existing association."],
    examples: [
      "ipab register set SCHEMA_CID reader",
      "ipab register set SCHEMA_CID reader '--' '--cid' '%'",
    ],
    notes: [
      "Replaces only the whole % argument with the content CID; no shell expansion.",
      "Does not verify App type support; open checks it before execution.",
    ],
  },
  "register remove": {
    summary: "Remove a saved content-type association",
    arguments: ["SCHEMA  Exact type CID or builtin:node-app.v1."],
    examples: ["ipab register remove SCHEMA_CID"],
    notes: ["Does not remove Apps, pins or content."],
  },
  "config get": {
    summary: "Show effective configuration",
    arguments: ["KEY  Optional configuration key; omit to show all values."],
    examples: ["ipab config get", "ipab config get store.rpc"],
  },
  "config set": {
    summary: "Save a local configuration value",
    examples: [
      "ipab config set store.rpc http://127.0.0.1:5001",
      "ipab config set history.enabled false",
    ],
    notes: [
      "store.rpc is a Kubo RPC API URL, not a gateway; no daemon is started.",
    ],
  },
  "config reset": {
    summary: "Remove a saved configuration override",
    examples: ["ipab config reset store.rpc"],
  },
  "history list": {
    summary: "List execution history",
    options: [
      "--app APP       Filter by App CID or named pin.",
      "--status STATUS succeeded, failed or cancelled.",
      "--since TIME    Include runs ended at or after TIME.",
      "--until TIME    Include runs ended before TIME.",
      "--limit N       Maximum number of records.",
      "--before RUN_ID Continue before a previous record.",
    ],
    examples: [
      "ipab history list",
      "ipab history list --status failed --limit 10",
    ],
    notes: [
      "Filters combine with AND; times use RFC3339 with an explicit timezone.",
    ],
  },
  "history show": {
    summary: "Show an execution record and available log paths",
    examples: ["ipab history show RUN_ID"],
    notes: ["Only runs started with --log have recorded stdout/stderr."],
  },
  "history remove": {
    summary: "Remove execution records and their logs",
    options: [
      "--app APP       Filter by App CID or named pin.",
      "--status STATUS succeeded, failed or cancelled.",
      "--since TIME    Include runs ended at or after TIME.",
      "--until TIME    Include runs ended before TIME.",
      "--yes           Skip confirmation; required outside an interactive terminal.",
    ],
    examples: [
      "ipab history remove RUN_ID --yes",
      "ipab history remove --status failed --until 2026-11-01T00:00:00Z --yes",
    ],
    notes: [
      "Use explicit IDs OR at least one filter, not both.",
      "Filters combine with AND; times use RFC3339 with an explicit timezone.",
      "Deletes associated logs and releases history retention; does not request Store GC.",
    ],
  },
};

export function help(path = ""): string {
  const globalOptions = `Global options (before COMMAND):
  --state-dir PATH  Set the local state directory
  --store-rpc URL   Use a Kubo RPC endpoint
  --json            Output management/development metadata, not App stdio`;
  const footer =
    "Full reference: https://github.com/silvermoon-work/ipab/blob/main/docs/reference.md";
  if (!path)
    return `IPAB — run Apps and open content by CID.

Usage: ipab [GLOBAL_OPTIONS] COMMAND

Run Apps:
  exec      ${commandHelp.exec!.summary}
  open      ${commandHelp.open!.summary}

Create:
  init      ${commandHelp.init!.summary}
  build     ${commandHelp.build!.summary}
  bundle    ${groups.bundle}

Manage:
  pin       ${groups.pin}
  register  ${groups.register}
  config    ${groups.config}
  history   ${groups.history}

${globalOptions}
  -h, --help        Show help for the current command
  --version         Show version

Run 'ipab COMMAND --help' for command details.
Apps are NOT sandboxed; run only Apps you trust.
${footer}`;
  const usage = commands[path];
  if (usage) {
    const topic = commandHelp[path]!;
    const section = (title: string, lines: string[]) =>
      `\n\n${title}:\n${lines.map((line) => `  ${line}`).join("\n")}`;
    return [
      `${topic.summary}.\n\nUsage: ipab [GLOBAL_OPTIONS] ${usage}`,
      ...(topic.arguments ? [section("Arguments", topic.arguments)] : []),
      ...(topic.options ? [section("Options", topic.options)] : []),
      section("Examples", topic.examples),
      ...(topic.notes ? [section("Notes", topic.notes)] : []),
      `\n\n-h, --help shows this help. Global options: see 'ipab --help'.\n${footer}`,
    ].join("");
  }
  const leaves = Object.keys(commands).filter((key) =>
    key.startsWith(`${path} `),
  );
  if (!leaves.length) syntax(`Unknown command "${path}".`);
  return `${groups[path]}.

Usage: ipab [GLOBAL_OPTIONS] ${path} COMMAND

Commands:
${leaves.map((key) => `  ${key.slice(path.length + 1).padEnd(8)}${commandHelp[key]!.summary}`).join("\n")}

Run 'ipab ${path} COMMAND --help' for command details.
Global options: see 'ipab --help'.
${footer}`;
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

function table(headers: string[], rows: string[][], empty: string): string {
  if (!rows.length) return empty;
  const cells = rows.map((row) => row.map(printable));
  const widths = headers.map((header, column) =>
    cells.reduce(
      (width, row) => Math.max(width, stringWidth(row[column]!)),
      stringWidth(header),
    ),
  );
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
  parameters?: string[];
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
    if (tokens[0] === "--log") {
      result.options.log = true;
      tokens.shift();
    }
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
        ? ["replace", "no-import", "with-source", "without-source"]
        : result.path === "register set"
          ? ["replace"]
          : result.path === "history remove"
            ? ["yes"]
            : result.path === "open"
              ? ["log"]
              : [];
  const values =
    result.path === "init"
      ? ["template"]
      : result.path === "bundle build" || result.path === "build"
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
      if (result.path === "init" && option === "param") {
        const input = tokens.shift();
        if (!input || input.startsWith("--") || input.indexOf("=") < 1)
          syntax("--param requires KEY=VALUE.");
        (result.parameters ??= []).push(input);
        continue;
      }
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
  if (result.options["with-source"] && result.options["without-source"])
    syntax("--with-source and --without-source are mutually exclusive.");
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
    pinName(result.positional[0]!, result.path === "pin show");
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
    const builtins = await builtinContent();
    state = new State(stateLocation(parsed.flags, env).path, builtins.pins);
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
            diagnostic: (text: string) => {
              io.err(text);
            },
            resolveCid: async (cid: CID, options: { signal?: AbortSignal }) => {
              options.signal?.throwIfAborted();
              const builtin = builtins.blocks.get(cid.toV1().toString());
              if (builtin) return builtin.slice();
              return (await getStore()).block.get(cid.toString(), options);
            },
          };
          const builtinSource = first ? state.pin(first) : undefined;
          const source =
            builtinSource?.builtin && builtinSource.metadata?.kind === "bundle"
              ? builtinSource.cid
              : first;
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
              ? await initApp(first!, second, {
                  ...request,
                  ...(typeof parsed.options.template === "string"
                    ? {
                        template: state.pin(parsed.options.template)?.builtin
                          ? parsed.options.template
                          : state.pin(parsed.options.template)
                            ? state.resolve(parsed.options.template)
                            : parsed.options.template,
                      }
                    : {}),
                  ...(parsed.parameters
                    ? { parameters: parsed.parameters }
                    : {}),
                })
              : parsed.path === "build"
                ? await buildApp(first, {
                    ...request,
                    replace: Boolean(parsed.options.replace),
                    ...(parsed.options["with-source"]
                      ? { includeSource: true }
                      : parsed.options["without-source"]
                        ? { includeSource: false }
                        : {}),
                    ...(typeof parsed.options.output === "string"
                      ? { output: parsed.options.output }
                      : {}),
                    outputDir: String(value("bundle.outputDir")),
                  })
                : parsed.path === "bundle init"
                  ? await initBundle(source!, second!, request)
                  : parsed.path === "bundle build"
                    ? await buildBundle(source!, {
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
                      : await inspectBundle(source!, request);
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
              `CID: ${result.cid}\nSchema CID: ${result.schemaCid}\nCAR: ${result.output}${"source" in result ? `\nSource CID: ${result.source.cid}\nSource CAR: ${result.source.output} (not imported or pinned)` : ""}\nStore: ${importing ? "imported (not pinned)" : "not imported (--no-import)"}`,
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
            ["NAME", "CID", "KIND", "BUNDLE TYPE", "SOURCE"],
            listed.map((pin) => [
              pin.name,
              pin.cid,
              pin.kind,
              pin.typeName ?? "(no Bundle type metadata)",
              pin.builtin ? "built-in (read-only)" : "user",
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
          `Name: ${printable(result.name)}\nCID: ${result.cid}\nKind: ${result.kind}\nBundle type: ${printable(result.typeName ?? "(no Bundle type metadata)")}${result.schemaCid ? `\nSchema CID: ${result.schemaCid}` : ""}\nSource: ${result.builtin ? "built-in (read-only; content bundled with IPAB)" : "local registration (not live node verification)"}`,
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
          cid === null
            ? "none"
            : cid + (names.has(cid) ? ` (${names.get(cid)!})` : "");
        const shortId = state.shortRunId.bind(state);
        const now = Date.now();
        const rows = page.items.length
          ? page.items
              .map((record) =>
                [
                  `run ${shortId(record.id)} | ${record.status} | ${endedDisplay(record.endedAt, now)}`,
                  `  App:    ${reference(record.appCid)}`,
                  `  Output: ${reference(record.outputCid)}`,
                  `  Argv:   ${record.argv.join(" ")}`,
                ]
                  .map(printable)
                  .join("\n"),
              )
              .join("\n\n")
          : "No ended executions.";
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
        const logs = record.log
          ? await logFiles(state.directory, record.id)
          : undefined;
        emit(
          logs ? { ...record, logs } : record,
          runDetails(record) +
            (logs
              ? `\nLog recording: ${record.log!}\nStdout log: ${printable(logs.stdout ?? "unavailable")}\nStderr log: ${printable(logs.stderr ?? "unavailable")}`
              : "\nLog recording: disabled"),
        );
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
        if (parsed.options.log && !value("history.enabled"))
          throw new HostError(
            "Execution logging requires history.enabled=true.",
          );
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
                log: Boolean(parsed.options.log),
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
              log: Boolean(parsed.options.log),
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
