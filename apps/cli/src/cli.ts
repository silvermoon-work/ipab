import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
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
  visibleConfig,
  type GlobalOptions,
} from "./config.js";
import { HostError, message, object, syntax } from "./errors.js";
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
import { buildBundle, inspectBundle, importBundle } from "./authoring.js";
import { initApp } from "./app-authoring.js";
import { assembleBundle } from "./assembly.js";
import { getBundle } from "./get.js";
import {
  createSwarm,
  requestMembership,
  approveMembership,
  joinSwarm,
  descriptor,
  swarmHeader,
  addSwarm,
  updateSwarm,
  searchNames,
  resolveReference,
  publish,
  type SwarmContext,
} from "./swarm.js";
import { schemaAlias } from "./app-definition.js";
import { addPin, deletePin, pinDetails, renamePin } from "./pins.js";
import { logFiles } from "./logs.js";
import { builtinContent } from "./builtins.js";
import { readSecretStream } from "./config-secret.js";

export interface IO {
  out(text: string): void;
  err(text: string): void;
  tty: boolean;
  columns?(): number | undefined;
  confirm(text: string): Promise<boolean>;
  readSecret?(): Promise<string>;
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
  async readSecret() {
    if (process.stdin.isTTY)
      syntax(
        "Pipe the API key through stdin; interactive echo is not permitted.",
      );
    process.stdin.setEncoding("utf8");
    return readSecretStream(process.stdin as AsyncIterable<string>);
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
  "swarm create": "swarm create [--service URL] [--resume OPERATION]",
  "swarm request": "swarm request SWARM_CID",
  "swarm approve": "swarm approve REQUEST_CID [--expires-in SECONDS] --yes",
  "swarm join": "swarm join RESPONSE_CID",
  "swarm status": "swarm status [SWARM_CID]",
  "swarm list": "swarm list",
  "swarm add": "swarm add SWARM_CID [--alias ALIAS]",
  "swarm use": "swarm use CID_OR_ALIAS",
  "swarm remove": "swarm remove CID_OR_ALIAS",
  "swarm update":
    "swarm update [CID_OR_ALIAS] [--name TEXT] [--description TEXT]",
  publish:
    "publish CID_OR_CAR [--name NAME [--expect OLD_NODE_CID | --snapshot]]",
  get: "get REF [--raw] [--force | --no-force] [-o DIRECTORY]",
  search: "search QUERY [--current] [--force | --no-force]",
  init: "init NAME [DIR] [OPTIONS]",
  build: "build [SOURCE] [OPTIONS]",
  "bundle build": "bundle build SOURCE [OPTIONS]",
  "bundle inspect": "bundle inspect SOURCE",
  "bundle import": "bundle import FILE.car",
  exec: "exec [--log] [--force | --no-force] APP [APP_ARGS...]",
  open: "open [--log] [--raw] [--force | --no-force] CONTENT",
  "pin add": "pin add NAME CID",
  "pin delete": "pin delete NAME",
  "pin list": "pin list [--type TYPE]",
  "pin show": "pin show NAME",
  "pin rename": "pin rename OLD_NAME NEW_NAME",
  "register list": "register list",
  "register set": "register set SCHEMA APP [--replace] [-- TEMPLATE...]",
  "register remove": "register remove SCHEMA",
  "config get": "config get [KEY]",
  "config set":
    "config set KEY VALUE\n       ipab config set pointers.apiKey - < protected-key-file",
  "config reset": "config reset KEY",
  "store usage": "store usage",
  "store gc": "store gc",
  "history list": "history list [OPTIONS]",
  "history show": "history show RUN_ID",
  "history remove":
    "history remove RUN_ID... [--yes]\n       ipab history remove FILTERS [--yes]",
};
const groups: Record<string, string> = {
  swarm: "Create, authorize, select and manage personal swarms",
  bundle: "Create, inspect and import content bundles",
  pin: "Retain content and manage short names",
  register: "Associate content types with Apps",
  config: "Manage local configuration",
  store: "Query local storage and collect unreferenced blocks",
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
  "swarm create": {
    summary: "Create a swarm using the account HOME identity",
    options: [
      "--service URL  Must match the protected pointers.service origin.",
      "--resume OPERATION  Recover the same saved create/idempotency result.",
      "--name TEXT  Initial mutable swarm name.",
      "--description TEXT  Initial mutable description.",
      "--alias ALIAS  Optional local registry alias (not the shared name).",
    ],
    examples: [
      "ipab config set pointers.service https://service.example",
      "ipab config set pointers.apiKey -",
      "ipab swarm create",
    ],
    notes: [
      "Creation uses the protected, origin-bound API key and owner possession proof.",
      "Uses the prepared private Kubo provider; never deploys infrastructure.",
      "Returns one descriptor CID; owner needs no member certificate.",
    ],
  },
  "swarm request": {
    summary: "Publish a signed account membership request",
    examples: ["ipab swarm request SWARM_CID"],
    notes: [
      "Returns one request CID. Private IPFS access is a prerequisite, not membership.",
    ],
  },
  "swarm approve": {
    summary: "Owner signs a certificate for an exact request",
    options: [
      "--yes  Explicit approval; required outside a TTY.",
      "--expires-in SECONDS  60..2592000; default 604800.",
    ],
    examples: ["ipab swarm approve REQUEST_CID --yes"],
    notes: ["Returns one response CID. Never exports the owner private key."],
  },
  "swarm join": {
    summary: "Verify a response and authenticate HEAD",
    examples: ["ipab swarm join RESPONSE_CID"],
    options: ["--alias ALIAS  Register this swarm with a local alias."],
    notes: [
      "Requires this account's exact pending request and bound member certificate.",
    ],
  },
  "swarm status": {
    summary: "Authenticate the current swarm HEAD",
    examples: ["ipab swarm status", "ipab swarm status work"],
    notes: [
      "Always authenticate and refresh HEAD; update the local header cache.",
    ],
  },
  "swarm list": {
    summary: "List local swarm registrations and the effective selection",
    examples: ["ipab swarm list", "ipab --json swarm list"],
    notes: ["Local only; does not verify remote membership or refresh HEAD."],
  },
  "swarm add": {
    summary: "Authenticate and register a swarm you already have access to",
    options: [
      "--alias ALIAS  Unique local alias; does not rename the shared swarm.",
    ],
    examples: ["ipab swarm add SWARM_CID --alias work"],
    notes: [
      "Not a membership grant. The first registration becomes the saved default only if none exists.",
    ],
  },
  "swarm use": {
    summary: "Save a registered swarm as the current default",
    examples: ["ipab swarm use work"],
    notes: ["Local only. --swarm still overrides the saved default."],
  },
  "swarm remove": {
    summary: "Forget a local registration without revoking membership",
    examples: ["ipab swarm remove work"],
    notes: [
      "Preserves credentials, content and remote membership. Clears a matching saved default without selecting a replacement.",
    ],
  },
  "swarm update": {
    summary: "Update shared swarm information as an owner or member",
    arguments: ["CID_OR_ALIAS  Defaults to the effective current swarm."],
    options: [
      "--name TEXT  Replace the shared display name; empty text clears it.",
      "--description TEXT  Replace the shared description; empty text clears it.",
    ],
    examples: [
      'ipab swarm update work --name "Team" --description "Shared workspace"',
      'ipab swarm update --description ""',
    ],
    notes: [
      "Requires at least one field. Any authorized member can update both fields.",
      "Last successful write wins for the specified fields; no expected-value/version input.",
      "Automatically retries HEAD contention while preserving current Names and unspecified properties.",
      "Shared name changes do not rename local registry aliases.",
    ],
  },
  search: {
    summary: "Search formal Names across registered swarms",
    arguments: [
      "QUERY  Case-insensitive literal name substring, 1..256 characters.",
    ],
    options: [
      "--current  Search only the effective current swarm; conflicts with --swarm.",
      "--force  Refresh HEAD for every swarm in the search scope.",
      "--no-force  Override swarm.forceRefresh and use valid cached headers.",
    ],
    examples: ["ipab search hello", "ipab --swarm work search hello --force"],
    notes: [
      "Searches all registered swarms unless --current or --swarm selects one.",
      "Valid caches use local Names only; absent/expired caches refresh. No payload downloads.",
      "No matches is success, not a reason to refresh valid caches. Any failed swarm fails the whole search.",
    ],
  },
  publish: {
    summary: "Provide built content and explicitly publish a Name",
    options: [
      "--name NAME  New formal Name; occupied Names fail.",
      "--expect CID  Exact old Artifact node, required for iteration.",
      "--snapshot  Name ordinary content without an Artifact; initial only.",
    ],
    examples: [
      "ipab publish app.car --name apps/hello",
      "ipab publish APP_CID --name apps/hello --expect OLD_NODE_CID",
      "ipab publish CONTENT_CID",
    ],
    notes: [
      "No build, edit, install or execution. CID-only stdout.",
      "Different-name CAS contention is rebased; same-name edits conflict (exit 3).",
      "Kubo pin confirmation precedes HEAD; it does not prove a remote device is online.",
    ],
  },
  get: {
    summary: "Verify and unpack Bundle content without executing it",
    options: [
      "--raw  Select the Artifact node instead of its value.",
      "--force  Refresh the shared Name's swarm HEAD.",
      "--no-force  Override swarm.forceRefresh and use valid cached headers.",
      "-o, --output DIRECTORY  New or empty directory; defaults to resolved CID.",
    ],
    examples: [
      "ipab --json get ipab:///apps/hello -o hello-app",
      "ipab get ipab://work/apps/hello -o hello-app",
      "ipab get --raw RELEASE_CID",
    ],
    notes: [
      "Returns the selected content CID and original target CID (editing baseline).",
      "ipab://SWARM_CID_OR_ALIAS/PATH selects its own swarm; ipab:///PATH uses --swarm or swarm.default.",
      "Does not install, build, edit, or automatically retrieve associated source.",
    ],
  },
  "store usage": {
    summary: "Query cached and recursively pinned block bytes",
    examples: ["ipab store usage", "ipab --json store usage"],
    notes: [
      "Local Store only; excludes metadata, temporary files and disk allocation overhead.",
      "Pinned DAGs include all descendants, with shared blocks counted once.",
    ],
  },
  "store gc": {
    summary: "Delete unprotected blocks from the entire selected local Store",
    examples: ["ipab store gc", "ipab --json store gc"],
    notes: [
      "Preserves pins, all participating owners, pending operations and staged imports.",
      "Does not unpin, clear history, delete unknown files or request Kubo daemon GC.",
    ],
  },
  init: {
    summary: "Create files from a Template Bundle (default: Node App project)",
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
    summary: "Assemble any Bundle using ipab.build.yaml (no compilation)",
    arguments: [
      "SOURCE  Recipe file or Bundle directory (default: current directory).",
    ],
    options: [
      "-o, --output FILE  Destination (default: dist/bundle.car).",
      "--replace         Allow replacing existing regular artifacts.",
      "--no-import       Write the CAR without importing the Bundle into Store.",
    ],
    examples: [
      "ipab build prepared-app",
      "ipab build ipab.build.yaml --replace",
    ],
    notes: [
      "Recipe explicitly maps source files and exact CID imports to target paths.",
      "Type and entry come from .bundle.yaml; imported DAG identities are preserved.",
      "Legacy App ipab.yaml is rejected; use project preparation tools separately.",
      "Select explicit files; review private files before providing Bundles.",
      "Store failures preserve the CAR; retry with ipab bundle import FILE.car.",
    ],
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
    summary: "Run an App by CID, named pin or IPAB URI",
    arguments: [
      "APP_ARGS  Everything after APP is passed verbatim, including --help.",
    ],
    options: [
      "--log  Record stdout/stderr; must precede APP. Requires history enabled.",
      "--force  Refresh the shared Name's swarm HEAD; must precede APP.",
      "--no-force  Override swarm.forceRefresh; must precede APP.",
    ],
    examples: [
      "ipab exec reader",
      "ipab exec reader --help",
      "ipab exec --log reader",
      "ipab exec ipab://work/apps/hello --help",
    ],
    notes: [
      "Apps are NOT sandboxed; run only Apps you trust.",
      "ipab://SWARM_CID_OR_ALIAS/PATH selects its own swarm; ipab:///PATH uses --swarm or swarm.default.",
      "History stores argv by default; do not put secrets in arguments.",
      "Logs may contain secrets; stdin is never logged. Logging makes output non-TTY.",
      "--json is not supported; App stdio is passed through.",
    ],
  },
  open: {
    summary: "Open content with its registered App",
    arguments: ["CONTENT  Bundle CID, named pin or IPAB URI."],
    options: [
      "--log  Record stdout/stderr; requires history enabled.",
      "--raw  Open the Artifact node rather than its value.",
      "--force  Refresh the shared Name's swarm HEAD.",
      "--no-force  Override swarm.forceRefresh and use valid cached headers.",
    ],
    examples: [
      "ipab open CONTENT_CID",
      "ipab open --log my-note",
      "ipab open ipab:///documents/readme",
    ],
    notes: [
      "Requires a saved registration and App support for the exact content type.",
      "ipab://SWARM_CID_OR_ALIAS/PATH selects its own swarm; ipab:///PATH uses --swarm or swarm.default.",
      "Apps are NOT sandboxed; run only Apps you trust.",
      "Logs may contain secrets; stdin is never logged. Logging makes output non-TTY.",
      "--json is not supported; App stdio is passed through.",
    ],
  },
  "pin add": {
    summary: "Verify, retain and name a Bundle",
    arguments: [
      "NAME  Unused short name.",
      "CID   Exact Bundle CID, not another pin name or a standalone type block.",
    ],
    examples: ["ipab pin add reader APP_CID"],
    notes: [
      "Validates a complete Bundle and retains its full DAG in the configured Store.",
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
      "--type TYPE  Exact type CID or the name of a Bundle pin of that type.",
    ],
    examples: ["ipab pin list", "ipab pin list --type reader"],
    notes: [
      "Unfinished operations and legacy non-Bundle pins are reported separately.",
      "Legacy retention is preserved; use pin delete to explicitly release it.",
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
    examples: ["ipab config get", "ipab config get store.gateway"],
  },
  "config set": {
    summary: "Save a local configuration value",
    examples: [
      "ipab config set pointers.apiKey -",
      "ipab config set store.gateway http://127.0.0.1:8080",
      "ipab config set history.enabled false",
    ],
    notes: [
      "store.gateway is a read-only HTTP gateway; blocks, pins and GC remain local.",
      "pointers.service is a canonical HTTPS origin (HTTP loopback allowed).",
      "pointers.apiKey is accepted only through stdin using VALUE '-'; queries and confirmations redact it.",
      "Saving pointers.apiKey protects state SQLite files with account-only Unix modes or Windows ACLs.",
    ],
  },
  "config reset": {
    summary: "Remove a saved configuration override",
    examples: ["ipab config reset store.gateway"],
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
  --swarm CID|ALIAS Select shared swarm (otherwise swarm.default; URI swarm takes precedence)
  --state-dir PATH  Set the local state directory
  --store-gateway URL  Use a read-only upstream HTTP gateway
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
  swarm     ${groups.swarm}
  search    Search formal Names across registered swarms
  publish   ${commandHelp.publish!.summary}
  get       ${commandHelp.get!.summary}
  pin       ${groups.pin}
  register  ${groups.register}
  config    ${groups.config}
  store     ${groups.store}
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

function runTime(value: string, field: "start" | "end"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new HostError(`Execution record has an invalid ${field} time.`);
  const pad = (part: number): string => String(part).padStart(2, "0");
  const day = [
    String(date.getFullYear()).padStart(4, "0"),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-");
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(pad)
    .join(":");
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
  return `${day} ${time} ${zone}`;
}

function runDuration(record: Pick<RunRecord, "startedAt" | "endedAt">): string {
  const started = Date.parse(record.startedAt);
  if (!Number.isFinite(started))
    throw new HostError("Execution record has an invalid start time.");
  const duration = Date.parse(record.endedAt) - started;
  if (!Number.isFinite(duration) || duration < 0)
    throw new HostError("Execution record has an invalid duration.");
  return `${Math.floor(duration / 1000)}s`;
}

function storageBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let scaled = bytes;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit++;
  }
  const exact = bytes.toLocaleString("en-US");
  return unit === 0
    ? `${exact} bytes`
    : `${scaled.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${units[unit]} (${exact} bytes)`;
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
    ["Started", runTime(record.startedAt, "start")],
    ["Ended", runTime(record.endedAt, "end")],
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
    else if (flag === "--store-rpc")
      syntax(
        "Store RPC is no longer supported. Use --store-gateway with an HTTP gateway URL; existing Kubo pins are not migrated.",
      );
    else if (
      flag === "--state-dir" ||
      flag === "--store-gateway" ||
      flag === "--swarm"
    ) {
      const value = tokens.shift();
      if (!value || value.startsWith("-")) syntax(`${flag} needs a value.`);
      if (flag === "--state-dir") flags.stateDir = value;
      else if (flag === "--swarm") flags.swarm = value;
      else {
        flags.storeGateway = publicUrl(value);
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
    while (["--log", "--force", "--no-force"].includes(tokens[0] ?? "")) {
      const option = tokens.shift()!.slice(2);
      if (Object.hasOwn(result.options, option))
        syntax(`Duplicate option --${option}.`);
      result.options[option] = true;
    }
    if (result.options.force && result.options["no-force"])
      syntax("--force and --no-force are mutually exclusive.");
    if (tokens[0] === "-h" || tokens[0] === "--help") {
      result.help = true;
      return result;
    }
    if (!tokens.length || tokens[0]!.startsWith("-"))
      syntax(`Expected APP.\n${help("exec")}`);
    result.positional = tokens;
    return result;
  }
  if (!["open", "init", "build", "publish", "get", "search"].includes(group)) {
    if (
      ![
        "bundle",
        "pin",
        "register",
        "config",
        "history",
        "store",
        "swarm",
      ].includes(group)
    )
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
  if (
    result.path === "config set" &&
    tokens.includes("pointers.apiKey") &&
    !(tokens.length === 2 && tokens[1] === "-")
  )
    syntax(
      "API key must be provided through '-' and piped stdin; never pass it in command arguments.",
    );
  const booleans =
    result.path === "bundle build"
      ? ["replace", "schema-only", "no-import"]
      : result.path === "build"
        ? ["replace", "no-import"]
        : result.path === "publish"
          ? ["snapshot"]
          : result.path === "get"
            ? ["raw", "force", "no-force"]
            : result.path === "search"
              ? ["current", "force", "no-force"]
              : result.path === "swarm approve"
                ? ["yes"]
                : result.path === "register set"
                  ? ["replace"]
                  : result.path === "history remove"
                    ? ["yes"]
                    : result.path === "open"
                      ? ["log", "raw", "force", "no-force"]
                      : [];
  const values =
    result.path === "swarm create"
      ? ["service", "resume", "name", "description", "alias"]
      : result.path === "swarm add" || result.path === "swarm join"
        ? ["alias"]
        : result.path === "swarm update"
          ? ["name", "description"]
          : result.path === "swarm approve"
            ? ["expires-in"]
            : result.path === "publish"
              ? ["name", "expect"]
              : result.path === "get"
                ? ["output"]
                : result.path === "init"
                  ? ["template"]
                  : result.path === "bundle build" || result.path === "build"
                    ? ["output"]
                    : result.path === "history list"
                      ? ["app", "status", "since", "until", "limit", "before"]
                      : result.path === "history remove"
                        ? ["app", "status", "since", "until"]
                        : result.path === "pin list"
                          ? ["type"]
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
        if (
          input === undefined ||
          input.startsWith("--") ||
          (input === "" && result.path !== "swarm update")
        )
          syntax(`${value} needs a value.`);
        result.options[option] = input;
      } else syntax(`Unknown option "${value}".`);
    } else result.positional.push(value);
  }
  if (result.options.force && result.options["no-force"])
    syntax("--force and --no-force are mutually exclusive.");
  if (
    result.path === "search" &&
    result.options.current &&
    flags.swarm !== undefined
  )
    syntax("--current and --swarm are mutually exclusive.");
  const counts: Record<string, [number, number]> = {
    "swarm create": [0, 0],
    "swarm request": [1, 1],
    "swarm approve": [1, 1],
    "swarm join": [1, 1],
    "swarm status": [0, 1],
    "swarm list": [0, 0],
    "swarm add": [1, 1],
    "swarm use": [1, 1],
    "swarm remove": [1, 1],
    "swarm update": [0, 1],
    publish: [1, 1],
    get: [1, 1],
    search: [1, 1],
    init: [1, 2],
    build: [0, 1],
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
    "store usage": [0, 0],
    "store gc": [0, 0],
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
  if (result.path.startsWith("config ") && result.positional[0]) {
    if (
      !(result.path === "config get" && result.positional[0] === "state-dir") &&
      !(result.path === "config reset" && result.positional[0] === "store.rpc")
    )
      configKey(result.positional[0]);
    if (result.path === "config set") {
      if (result.positional[0] === "pointers.apiKey") {
        if (result.positional[1] !== "-")
          syntax(
            "Set pointers.apiKey using '-' and piped stdin; never put the key in command-line arguments.",
          );
      } else
        parseValue(configKey(result.positional[0]), result.positional[1], true);
    }
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
      const pkg = object(
        JSON.parse(
          await readFile(new URL("../package.json", import.meta.url), "utf8"),
        ) as unknown,
        "CLI package",
      );
      if (typeof pkg.version !== "string" || !pkg.version.trim())
        throw new HostError("CLI package is missing its version.");
      io.out(pkg.version);
      return 0;
    }
    if (parsed.path === "history remove" && !parsed.options.yes && !io.tty)
      syntax("Non-interactive history remove requires --yes.");
    const builtins = await builtinContent();
    state = new State(stateLocation(parsed.flags, env).path, builtins.pins);
    if (
      parsed.path === "config reset" &&
      parsed.positional[0] === "store.rpc"
    ) {
      state.resetConfig("store.rpc");
      io.out(
        parsed.flags.json
          ? JSON.stringify({ reset: ["store.rpc"] })
          : "Removed legacy store.rpc configuration. Existing Kubo pins and content are unchanged.",
      );
      return 0;
    }
    const items = effectiveConfig(
      state.config(),
      parsed.flags,
      env,
      (reference) => state!.resolveSwarm(reference),
    );
    const value = (key: string) =>
      items.find((item) => item.key === key)!.value;
    const emit = (result: unknown, human: string) => {
      io.out(parsed.flags.json ? JSON.stringify(result) : human);
    };
    const [first, second] = parsed.positional;
    const selectedSwarm =
      value("swarm.default") === null
        ? undefined
        : String(value("swarm.default"));
    const swarmContext = (): SwarmContext => ({
      store: store!,
      state: state!,
      env,
      stateDir: stateLocation(parsed.flags, env).path,
      provider: String(value("swarm.provider") ?? "http://127.0.0.1:5001"),
      cacheTtl: Number(value("swarm.cacheTtl")),
      forceRefresh: parsed.options.force
        ? true
        : parsed.options["no-force"]
          ? false
          : Boolean(value("swarm.forceRefresh")),
      diagnostic: (text) => {
        io.err(text);
      },
      ...(typeof value("pointers.service") === "string"
        ? { pointerService: String(value("pointers.service")) }
        : {}),
      ...(typeof value("pointers.apiKey") === "string"
        ? { pointerApiKey: String(value("pointers.apiKey")) }
        : {}),
    });
    const filter = parsed.path.startsWith("history ")
      ? filters(state, parsed.options)
      : {};
    const selection = () => {
      const current = effectiveConfig(
        state!.config(),
        parsed.flags,
        env,
        (reference) => state!.resolveSwarm(reference),
      ).find((item) => item.key === "swarm.default")!;
      return {
        savedCurrent: state!.config()["swarm.default"] ?? null,
        effectiveCurrent: current.value,
        source: current.source,
      };
    };
    switch (parsed.path) {
      case "swarm list": {
        const result = { swarms: state.swarms(), ...selection() };
        emit(
          result,
          [
            ...result.swarms.map(
              (entry) =>
                `${entry.cid === result.savedCurrent ? "*" : " "} ${printable(entry.alias ?? entry.cid)}  ${entry.cid}`,
            ),
            `Saved current: ${result.savedCurrent ?? "(none)"}`,
            `Effective current: ${result.effectiveCurrent ?? "(none)"} (${result.source})`,
          ].join("\n"),
        );
        break;
      }
      case "swarm use": {
        state.useSwarm(first!);
        const result = selection();
        emit(result, `Saved current swarm: ${result.savedCurrent}`);
        if (result.source === "flag" || result.source === "env")
          io.err(
            `The saved default is overridden by ${result.source}: ${result.effectiveCurrent}.`,
          );
        break;
      }
      case "swarm remove": {
        const removed = state.removeSwarm(first!);
        emit(
          { removed, savedCurrent: state.config()["swarm.default"] ?? null },
          `Removed registration ${removed}. Credentials, content and remote membership are unchanged.`,
        );
        break;
      }
      case "swarm add":
      case "swarm update":
      case "search":
      case "swarm create":
      case "swarm request":
      case "swarm approve":
      case "swarm join":
      case "swarm status":
      case "publish":
      case "get": {
        store = new IpfsStore(await storeConfiguration(value("store.gateway")));
        const context = swarmContext();
        if (parsed.path === "swarm update") {
          const cid = first ? state.resolveSwarm(first) : selectedSwarm;
          if (!cid)
            syntax(
              "swarm update requires a registered alias, Swarm CID or current swarm.",
            );
          const result = await updateSwarm(context, cid, {
            ...(typeof parsed.options.name === "string"
              ? { name: parsed.options.name }
              : {}),
            ...(typeof parsed.options.description === "string"
              ? { description: parsed.options.description }
              : {}),
          });
          emit(
            result,
            `Swarm: ${result.cid}\nName: ${printable(result.properties.name)}\nDescription: ${printable(result.properties.description)}\nHEAD: ${result.root}\nRevision: ${result.revision}`,
          );
          break;
        }
        if (parsed.path === "swarm add") {
          const cid = exactCid(first!);
          await addSwarm(
            context,
            cid,
            typeof parsed.options.alias === "string"
              ? parsed.options.alias
              : undefined,
          );
          const entry = state.registeredSwarm(cid);
          emit(
            { ...entry, savedCurrent: state.config()["swarm.default"] ?? null },
            `Registered swarm ${entry.alias ?? cid} (${cid}).`,
          );
          break;
        }
        if (parsed.path === "search") {
          const source = items.find(
            (item) => item.key === "swarm.default",
          )!.source;
          const limited = parsed.options.current || source === "flag";
          if (limited && !selectedSwarm)
            syntax(
              "Search of the current swarm requires --swarm or swarm.default.",
            );
          const registrations = state.swarms();
          const scope = limited
            ? [
                {
                  cid: selectedSwarm!,
                  alias:
                    registrations.find((entry) => entry.cid === selectedSwarm)
                      ?.alias ?? null,
                },
              ]
            : registrations;
          const result = await searchNames(context, first!, scope);
          emit(
            result,
            result.matches.length
              ? result.matches
                  .map(
                    (match) =>
                      `${printable(match.alias ?? match.swarm)}  ${printable(match.name)}  ${match.targetCid}\n  ipab get ${printable(match.reference)}`,
                  )
                  .join("\n")
              : "No matching Names.",
          );
          break;
        }
        if (parsed.path === "swarm status") {
          const cid = first ? state.resolveSwarm(first) : selectedSwarm;
          if (!cid)
            syntax("swarm status requires a Swarm CID or swarm.default.");
          const data = await descriptor(store, cid);
          const { head, snapshot } = await swarmHeader(context, cid, true);
          emit(
            {
              cid,
              ...data,
              root: head.root,
              revision: head.revision,
              properties: snapshot.properties,
            },
            `Swarm: ${cid}\nName: ${printable(snapshot.properties.name)}\nDescription: ${printable(snapshot.properties.description)}\nHEAD: ${head.root}\nRevision: ${head.revision}`,
          );
          break;
        }
        if (parsed.path === "get") {
          const selected = await resolveReference(
            context,
            first!,
            selectedSwarm,
            (reference) => state!.resolve(reference),
            Boolean(parsed.options.raw),
          );
          const directory = await getBundle(
            store,
            selected.cid,
            typeof parsed.options.output === "string"
              ? parsed.options.output
              : undefined,
          );
          emit(
            { ...selected, directory },
            `CID: ${selected.cid}\nTarget CID: ${selected.targetCid}\nDirectory: ${directory}`,
          );
          break;
        }
        let cid: string;
        if (parsed.path === "swarm create") {
          cid = await createSwarm(context, {
            ...(typeof parsed.options.service === "string"
              ? { service: parsed.options.service }
              : {}),
            ...(typeof parsed.options.resume === "string"
              ? { resume: parsed.options.resume }
              : {}),
            properties: {
              name: String(parsed.options.name ?? ""),
              description: String(parsed.options.description ?? ""),
            },
            ...(typeof parsed.options.alias === "string"
              ? { alias: parsed.options.alias }
              : {}),
          });
        } else if (parsed.path === "swarm request")
          cid = await requestMembership(context, exactCid(first!));
        else if (parsed.path === "swarm approve") {
          if (
            !parsed.options.yes &&
            (!io.tty ||
              !(await io.confirm(
                `Approve membership request ${first!}? This grants swarm HEAD read/write access.`,
              )))
          )
            throw new HostError(
              "Approval requires explicit --yes or interactive confirmation.",
            );
          cid = await approveMembership(
            context,
            exactCid(first!),
            parsed.options["expires-in"] === undefined
              ? undefined
              : Number(parsed.options["expires-in"]),
          );
        } else if (parsed.path === "swarm join")
          cid = await joinSwarm(
            context,
            exactCid(first!),
            typeof parsed.options.alias === "string"
              ? parsed.options.alias
              : undefined,
          );
        else {
          let content: string;
          if (first!.toLowerCase().endsWith(".car"))
            content = (
              await importBundle(first!, () => Promise.resolve(store!))
            ).cid;
          else content = exactCid(first!);
          cid = await publish(context, content, {
            ...(selectedSwarm ? { swarm: selectedSwarm } : {}),
            ...(typeof parsed.options.name === "string"
              ? { name: parsed.options.name }
              : {}),
            ...(typeof parsed.options.expect === "string"
              ? { expect: parsed.options.expect }
              : {}),
            snapshot: Boolean(parsed.options.snapshot),
          });
        }
        if (parsed.path === "swarm create" || parsed.path === "swarm join")
          io.err(
            `Registered swarm ${state.registeredSwarm(cid).alias ?? cid}. Saved current: ${state.config()["swarm.default"] ?? "(none)"}.`,
          );
        emit({ cid }, cid);
        break;
      }
      case "store usage":
      case "store gc": {
        store = new IpfsStore(await storeConfiguration(value("store.gateway")));
        if (parsed.path === "store usage") {
          const result = await store.usage();
          emit(
            result,
            `Cached blocks: ${storageBytes(result.cachedBytes)}\nPinned blocks (deduplicated): ${storageBytes(result.pinnedBytes)}`,
          );
        } else {
          const result = await store.gc();
          emit(
            result,
            `Removed ${result.removedBlocks} blocks; reclaimed ${storageBytes(result.reclaimedBytes)}.`,
          );
        }
        break;
      }
      case "init":
      case "build":
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
            pendingStore ??= storeConfiguration(value("store.gateway")).then(
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
                ? "Assembling and validating Bundle (no compilation)..."
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
                ? await assembleBundle(first, {
                    ...request,
                    replace: Boolean(parsed.options.replace),
                    ...(typeof parsed.options.output === "string"
                      ? { output: parsed.options.output }
                      : {}),
                    outputDir: String(value("bundle.outputDir")),
                  })
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
              `CID: ${result.cid}\nSchema CID: ${result.schemaCid}\nCAR: ${result.output}${result.validation !== undefined ? `\nEntry validation: ${result.validation?.status ?? "not-applicable"}` : ""}\nStore: ${importing ? "imported (not pinned)" : "not imported (--no-import)"}`,
            );
          else if (result.kind === "bundle-import")
            emit(
              result,
              `Imported CID: ${result.cid}\nSchema CID: ${result.schemaCid}\nBlocks: ${result.blocks}\nCAR: ${result.source}\nEntry validation: ${result.validation?.status ?? "not-applicable"}`,
            );
          else if (result.kind === "project-init") {
            emit(
              result,
              `Created project: ${result.directory}${result.templateCid ? `\nTemplate CID: ${result.templateCid}` : ""}`,
            );
            if (
              result.files.includes("package.json") &&
              (result.files.includes("ipab.yaml") ||
                result.files.includes("ipab.json"))
            )
              io.err(
                `Next: install declared dependencies and explicitly link the candidate @ipab/cli as a project dependency in ${JSON.stringify(result.directory)}; run pnpm build to prepare and package the App. Root ipab build does not compile.`,
              );
            else if (result.files.includes(".bundle.yaml"))
              io.err(
                `Next: ipab bundle build ${JSON.stringify(result.directory)}`,
              );
          } else
            emit(
              result,
              `Kind: ${result.kind}\nName: ${printable(result.name)}\nSchema CID: ${result.schemaCid}\nEntry: ${result.entry.path} (${result.entry.contentType})\nDefinition validation: passed\nStorage verification: ${result.validation.storage}\nEntry validation: ${result.validation.entry?.status ?? "not-applicable"}`,
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
        const type =
          typeof parsed.options.type === "string"
            ? state.resolve(parsed.options.type, true)
            : undefined;
        const pins = state.pins();
        const listed = pins
          .filter(
            (pin) => pin.status === "ready" && pin.metadata?.kind === "bundle",
          )
          .map(pinDetails)
          .filter((pin) => type === undefined || pin.schemaCid === type);
        const invalid = pins
          .filter(
            (pin) => pin.status === "ready" && pin.metadata?.kind !== "bundle",
          )
          .map(({ name, cid, metadata }) => ({
            name,
            cid,
            kind: metadata?.kind,
            reason:
              "Not a Bundle pin; retention is preserved. Use pin delete to release it.",
          }));
        const pending = pins
          .filter((pin) => pin.status !== "ready")
          .map(({ name, cid, status }) => ({ name, cid, status }));
        if (pending.length)
          io.err(
            `Unfinished pin operations (not usable pins): ${JSON.stringify(pending)}. Retry pin add/delete.`,
          );
        if (invalid.length)
          io.err(
            `Legacy non-Bundle pins (not usable pins): ${JSON.stringify(invalid)}. Retention is unchanged; delete explicitly and wrap content in a Bundle before pinning again.`,
          );
        emit(
          { items: listed, pending, invalid },
          table(
            ["NAME", "CID", "KIND", "BUNDLE TYPE", "SOURCE"],
            listed.map((pin) => [
              pin.name,
              pin.cid,
              pin.kind,
              pin.typeName,
              pin.builtin ? "built-in (read-only)" : "user",
            ]),
            "No named pins.",
          ),
        );
        break;
      }
      case "pin add": {
        io.err("Fetching, verifying and retaining content in Store...");
        const result = await addPin(
          state,
          first!,
          second!,
          await storeConfiguration(value("store.gateway")),
        );
        emit(
          result,
          `${result.name} → ${result.cid}\nBundle type: ${printable(result.typeName)}`,
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
          `Name: ${printable(result.name)}\nCID: ${result.cid}\nBundle type: ${printable(result.typeName)}\nSchema CID: ${result.schemaCid}\nSource: ${result.builtin ? "built-in (read-only; content bundled with IPAB)" : "local registration (not live node verification)"}`,
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
        const selected = (
          first ? items.filter((item) => item.key === first) : items
        ).map(visibleConfig);
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
        const saved = parseValue(
          key,
          key === "pointers.apiKey"
            ? await (io.readSecret ?? processIO.readSecret!)()
            : second,
          true,
        );
        state.setConfig(key, saved);
        const source = items.find((item) => item.key === key)!.source;
        if (source === "env" || source === "flag")
          io.err(`Warning: saved user value is masked by ${source}.`);
        const display = visibleConfig({ key, value: saved, source: "user" });
        emit(
          display,
          `Saved ${key} = ${printable(String(display.value))} (user).`,
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
        const rows = page.items.length
          ? page.items
              .map((record) =>
                [
                  `run ${record.id}`,
                  `  Status:   ${record.status}`,
                  `  Started:  ${runTime(record.startedAt, "start")}`,
                  `  Ended:    ${runTime(record.endedAt, "end")}`,
                  `  Duration: ${runDuration(record)}`,
                  `  App:      ${reference(record.appCid)}`,
                  `  Output:   ${reference(record.outputCid)}`,
                  `  Argv:     ${record.argv.join(" ")}`,
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
        await recoverInactive(state);
        store = new IpfsStore(await storeConfiguration(value("store.gateway")));
        const target = (
          await resolveReference(
            swarmContext(),
            first!,
            selectedSwarm,
            (reference) => state!.resolve(reference),
            Boolean(parsed.options.raw),
          )
        ).cid;
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
