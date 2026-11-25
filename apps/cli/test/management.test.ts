import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli, help, parse } from "../src/cli.js";
import {
  configKey,
  effectiveConfig,
  parseValue,
  publicUrl,
  stateLocation,
  storeConfiguration,
  validateUserConfig,
} from "../src/config.js";
import { HostError, message, object } from "../src/errors.js";
import { pinName, exactCid, State } from "../src/state.js";
import { appSchemaCid } from "../src/space.js";
import { appBuiltinAlias } from "../src/app-definition.js";
import { builtinContent } from "../src/builtins.js";
import { pinDetails } from "../src/pins.js";
import {
  fixture,
  cli,
  record,
  importFiles,
  seedDisplayPin,
} from "./helpers.js";

describe("management contract", () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  let builtinPins: ReturnType<typeof pinDetails>[];
  beforeEach(async () => {
    work = await fixture();
    builtinPins = (await builtinContent()).pins.map(pinDetails);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await work.cleanup();
  });
  const schema = appSchemaCid.toString();
  const another = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

  it("management tables/details are human-readable while JSON schemas remain unchanged", async () => {
    const state = new State(work.stateDir);
    const output = await importFiles(work.store, { file: "output" });
    const association = state.setAssociation(
      schema,
      another,
      ["--cid", "%", "multi word"],
      false,
    );
    seedDisplayPin(state, "reader", another);
    const failed = record("run-001", another, {
      argv: ["multi word", ""],
      status: "failed",
      appExitCode: 7,
      error: {
        phase: "execution",
        code: "APP_EXIT",
        message: "Failed\nsecond line",
      },
    });
    const succeeded = record("run-002", another, {
      origin: "open",
      endedAt: "2026-11-23T00:00:02Z",
      outputCid: output,
      retention: { owned: true, state: "retained", owner: "record-owner" },
    });
    state.saveRun(failed);
    state.saveRun(succeeded);
    state.close();
    const pins = await cli(work.stateDir, ["pin", "list"]);
    expect(pins.out).toMatch(
      /^NAME\s+CID\s+KIND\s+BUNDLE TYPE\s+SOURCE\nreader\s+/,
    );
    expect(pins.out).toContain(another);
    expect(
      JSON.parse(
        (await cli(work.stateDir, ["--json", "pin", "list"])).out,
      ) as unknown,
    ).toEqual({
      items: [
        {
          name: "reader",
          cid: another,
          kind: "content",
          typeName: null,
          schemaCid: null,
        },
        ...builtinPins,
      ],
      pending: [],
      legacyAliases: [],
    });
    const registered = await cli(work.stateDir, ["register", "list"]);
    expect(registered.out).toMatch(/^SCHEMA CID\s+APP CID\s+ARGV\n/);
    expect(registered.out).toContain(JSON.stringify(association.argv));
    expect(
      JSON.parse(
        (await cli(work.stateDir, ["--json", "register", "list"])).out,
      ) as unknown,
    ).toEqual({ items: [association] });
    const config = await cli(work.stateDir, [
      "config",
      "get",
      "history.enabled",
    ]);
    expect(config.out).toMatch(
      /^KEY\s+VALUE\s+SOURCE\nhistory.enabled\s+true\s+default$/,
    );
    expect(
      JSON.parse(
        (
          await cli(work.stateDir, [
            "--json",
            "config",
            "get",
            "history.enabled",
          ])
        ).out,
      ) as unknown,
    ).toEqual({
      items: [{ key: "history.enabled", value: true, source: "default" }],
    });
    const page = await cli(work.stateDir, ["history", "list", "--limit", "1"]);
    expect(page.out).toMatch(/^run run-002 \| succeeded \|/);
    expect(page.out).toContain("reader");
    expect(page.out).toContain(`Output: ${output}`);
    expect(page.out).toContain("use --before run-002 with the same filters");
    const machine = JSON.parse(
      (await cli(work.stateDir, ["--json", "history", "list", "--limit", "1"]))
        .out,
    ) as unknown;
    expect(machine).toEqual({
      items: [
        {
          id: succeeded.id,
          appCid: succeeded.appCid,
          argv: succeeded.argv,
          startedAt: succeeded.startedAt,
          endedAt: succeeded.endedAt,
          status: succeeded.status,
          outputCid: succeeded.outputCid,
        },
      ],
      nextBefore: "run-002",
    });
    const details = await cli(work.stateDir, ["history", "show", "run-001"]);
    expect(details.code).toBe(0);
    expect(details.out).toContain("Run: run-001\nOrigin: exec");
    expect(details.out).toContain('Argv: ["multi word",""]');
    expect(details.out).toContain(
      "Status: failed\nApp exit: 7\nOutput CID: none",
    );
    expect(details.out).toContain("Retention: none (not record-owned)");
    expect(details.out).toContain(
      "Error: execution/APP_EXIT: Failed\\nsecond line",
    );
    expect(
      JSON.parse(
        (await cli(work.stateDir, ["--json", "history", "show", "run-001"]))
          .out,
      ) as unknown,
    ).toEqual(failed);
    const retained = await cli(work.stateDir, ["history", "show", "run-002"]);
    expect(retained.out).toContain("Retention: retained (record-owned)");
    expect(retained.out).toContain("Error: none");
    expect(retained.out).toContain("Retention owner: record-owner");
    expect(
      [pins, registered, config, page, details, retained].every(
        (result) => result.err === "",
      ),
    ).toBe(true);
  });

  it("history lists full references, current pin names and joined arguments without changing full records", async () => {
    const argv = ["--flag", "two words", "", 'quote"x', "\n"];
    const state = new State(work.stateDir);
    seedDisplayPin(state, "z-reader", another);
    seedDisplayPin(state, "reader", another);
    seedDisplayPin(state, "result", schema);
    state.saveRun(record("readable-run", another, { argv, outputCid: schema }));
    state.close();
    const result = await cli(work.stateDir, ["history", "list"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("reader");
    expect(result.out).toContain("result");
    expect(result.out).not.toContain("z-reader");
    expect(result.out).toContain(`${another} (reader)`);
    expect(result.out).toContain(`${schema} (result)`);
    expect(result.out).toContain('--flag two words  quote"x \\n');
    expect(result.out.split("\n")).toHaveLength(4);
    const machine = await cli(work.stateDir, ["--json", "history", "list"]);
    expect(JSON.parse(machine.out) as unknown).toMatchObject({
      items: [{ appCid: another, outputCid: schema, argv }],
    });
    const details = await cli(work.stateDir, [
      "history",
      "show",
      "readable-run",
    ]);
    expect(details.out).toContain(`App CID: ${another}`);
    expect(details.out).toContain(`Output CID: ${schema}`);
    expect(details.out).toContain(`Argv: ${JSON.stringify(argv)}`);
  });

  it("history preserves long arguments, Unicode and full names without truncation", async () => {
    const state = new State(work.stateDir);
    for (const length of [47, 48, 49]) {
      state.saveRun(
        record(`run-${length}`, another, {
          outputCid: schema,
          argv: ["x".repeat(length)],
        }),
      );
    }
    state.saveRun(
      record("unicode-run", another, { argv: ["\u{1f600}".repeat(49)] }),
    );
    state.close();
    const result = await cli(work.stateDir, ["history", "list"]);
    expect(result.code).toBe(0);
    for (const length of [47, 48, 49]) {
      expect(result.out).toContain(`Argv:   ${"x".repeat(length)}`);
    }
    expect(result.out).toContain(`Argv:   ${"\u{1f600}".repeat(49)}`);
    expect(result.out).toContain(another);
    expect(result.out).toContain(schema);
    const updated = new State(work.stateDir);
    seedDisplayPin(updated, "a-long-readable-app-name", another);
    updated.close();
    const aliased = await cli(work.stateDir, ["history", "list"]);
    expect(aliased.out).toContain(`${another} (a-long-readable-app-name)`);
  });

  it("short run IDs remain unique across pages and resolve safely for show, pagination and removal", async () => {
    const firstId = "01234567-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondId = "01234567-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const state = new State(work.stateDir);
    state.saveRun(
      record(firstId, another, { endedAt: "2026-11-23T00:00:02Z" }),
    );
    state.saveRun(record(secondId, another));
    state.close();
    const page = await cli(work.stateDir, ["history", "list", "--limit", "1"]);
    expect(page.code).toBe(0);
    expect(page.out).toMatch(/^run 01234567-a \|/);
    expect(page.out).toContain("use --before 01234567-a with the same filters");
    expect(page.out).not.toContain(firstId);
    const next = await cli(work.stateDir, [
      "history",
      "list",
      "--before",
      "01234567-a",
    ]);
    expect(next.out).toMatch(/^run 01234567-b \|/);
    const details = await cli(work.stateDir, [
      "--json",
      "history",
      "show",
      "01234567-a",
    ]);
    expect(JSON.parse(details.out) as unknown).toMatchObject({ id: firstId });
    const ambiguous = await cli(work.stateDir, [
      "history",
      "remove",
      "01234567",
      "--yes",
    ]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("Ambiguous run ID prefix");
    const remaining = await cli(work.stateDir, [
      "--json",
      "history",
      "list",
      "--limit",
      "1",
    ]);
    expect(JSON.parse(remaining.out) as unknown).toMatchObject({
      items: [{ id: firstId }],
      nextBefore: firstId,
    });
    const short = await cli(work.stateDir, ["history", "show", "0123456"]);
    expect(short.code).toBe(1);
    const removed = await cli(work.stateDir, [
      "--json",
      "history",
      "remove",
      "01234567-a",
      firstId,
      "--yes",
    ]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.out) as unknown).toEqual({
      removed: [firstId],
      retentionClaimsReleased: true,
      garbageCollectionGuaranteed: false,
    });
    for (const wildcard of ["0123456*", "0123456?"]) {
      const rejected = await cli(work.stateDir, [
        "history",
        "remove",
        wildcard,
        "--yes",
      ]);
      expect(rejected.code).toBe(1);
      expect(rejected.err).toContain("does not exist");
    }
    expect((await cli(work.stateDir, ["history", "show", secondId])).code).toBe(
      0,
    );
    const literal = new State(work.stateDir);
    literal.saveRun(record("literal[*?]-abcdef", another));
    literal.close();
    const escaped = await cli(work.stateDir, [
      "--json",
      "history",
      "show",
      "literal[*?",
    ]);
    expect(escaped.code).toBe(0);
    expect(JSON.parse(escaped.out) as unknown).toMatchObject({
      id: "literal[*?]-abcdef",
    });
  });

  it("history preserves all fields regardless of terminal width", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-23T12:00:00Z"));
    const argv = ["--flag", "x".repeat(90)];
    const state = new State(work.stateDir);
    state.saveRun(record("term-run", another, { argv, outputCid: schema }));
    state.close();
    for (const columns of [10, 70, 80, 120, 200]) {
      const result = await cli(work.stateDir, ["history", "list"], { columns });
      expect(result.code).toBe(0);
      expect(result.out).toContain(`App:    ${another}`);
      expect(result.out).toContain(`Output: ${schema}`);
      expect(result.out).toContain(`Argv:   ${argv.join(" ")}`);
    }
    const machine = await cli(work.stateDir, ["--json", "history", "list"], {
      columns: 0,
    });
    expect(JSON.parse(machine.out) as unknown).toMatchObject({
      items: [{ argv }],
    });
  });

  it("history preserves complete grapheme clusters in joined argv", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-23T12:00:00Z"));
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
    for (const glyph of ["\u4f60", family, "e\u0301"]) {
      const state = new State(work.stateDir);
      state.saveRun(
        record("term-run", another, {
          outputCid: schema,
          argv: [glyph.repeat(40)],
        }),
      );
      state.close();
      const result = await cli(work.stateDir, ["history", "list"], {
        columns: 80,
      });
      expect(result.code).toBe(0);
      expect(result.out).toContain(`Argv:   ${glyph.repeat(40)}`);
    }
  });

  it("history shows relative end times at minute/hour/day boundaries while full timestamps remain available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-23T12:00:00Z"));
    const cases = [
      ["recent", "2026-11-23T11:59:30Z", "0m"],
      ["minutes", "2026-11-23T11:50:00Z", "10m"],
      ["one-hour", "2026-11-23T11:00:00Z", "1h"],
      ["hours", "2026-11-23T07:00:00Z", "5h"],
      ["one-day", "2026-11-22T12:00:00Z", "2026-11-22"],
      ["older", "2026-11-21T12:00:00Z", "2026-11-21"],
      ["future", "2026-11-24T12:00:00Z", "2026-11-24"],
    ] as const;
    const state = new State(work.stateDir);
    for (const [id, endedAt] of cases)
      state.saveRun(record(id, another, { endedAt }));
    state.close();
    const listed = await cli(work.stateDir, ["history", "list"]);
    expect(listed.code).toBe(0);
    for (const [id, , ended] of cases) {
      expect(listed.out).toContain(`run ${id} | succeeded | ${ended}`);
    }
    const machine = await cli(work.stateDir, ["--json", "history", "list"]);
    expect(JSON.parse(machine.out) as unknown).toHaveProperty(
      "items",
      expect.arrayContaining([
        expect.objectContaining({ id: "minutes", endedAt: cases[1][1] }),
      ]),
    );
    const details = await cli(work.stateDir, ["history", "show", "minutes"]);
    expect(details.out).toContain(`Ended: ${cases[1][1]}`);
    const corrupt = new State(work.stateDir);
    corrupt.saveRun(record("invalid", another, { endedAt: "not-a-date" }));
    corrupt.close();
    const failed = await cli(work.stateDir, ["history", "list"]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("invalid end time");
  });

  it("empty human lists succeed clearly and confirmations are not JSON fallbacks", async () => {
    for (const [group, text] of [
      ["register", "No associations."],
      ["history", "No ended executions."],
    ])
      expect((await cli(work.stateDir, [group!, "list"])).out).toBe(text);
    expect(
      (await cli(work.stateDir, ["config", "set", "history.limit", "5"])).out,
    ).toBe("Saved history.limit = 5 (user).");
    expect(
      (await cli(work.stateDir, ["config", "reset", "history.limit"])).out,
    ).toBe("Reset user override: history.limit.");
    expect(
      (await cli(work.stateDir, ["register", "set", schema, another])).out,
    ).toBe(`${schema} → ${another} ["%"]`);
    expect((await cli(work.stateDir, ["register", "remove", schema])).out).toBe(
      `Removed association for ${schema}.`,
    );
    const state = new State(work.stateDir);
    state.saveRun(record("unknown-exit", another, { appExitCode: null }));
    state.close();
    expect(
      (await cli(work.stateDir, ["history", "show", "unknown-exit"])).out,
    ).toContain("App exit: unavailable");
  });

  it("help/version never read malformed config or create state", async () => {
    const paths = [
      "",
      "exec",
      "open",
      "pin",
      "register",
      "config",
      "history",
      ...[
        "pin list",
        "pin add",
        "pin delete",
        "pin show",
        "pin rename",
        "register list",
        "register set",
        "register remove",
        "config get",
        "config set",
        "config reset",
        "history list",
        "history show",
        "history remove",
      ],
    ];
    for (const path of paths)
      for (const flag of ["-h", "--help"]) {
        const result = await cli(
          work.stateDir,
          [...path.split(" ").filter(Boolean), flag],
          { env: { IPAB_HISTORY_ENABLED: "bad" } },
        );
        expect(result.code).toBe(0);
        expect(result.out).toContain("Usage:");
        expect(result.err).toBe("");
      }
    for (const group of ["pin", "register", "config", "history", ""])
      expect((await cli(work.stateDir, group ? [group] : [])).code).toBe(0);
    expect((await cli(work.stateDir, ["--version"])).out).toBe("0.0.0");
    expect(existsSync(work.stateDir)).toBe(false);
  });

  it.each([
    ["unknown"],
    ["--unknown"],
    ["--state-dir"],
    ["--store-rpc"],
    ["--store-rpc", "default", "config", "get"],
    ["--version", "exec"],
    ["exec"],
    ["exec", "--cid"],
    ["--json", "exec", another],
    ["--json", "open", another],
    ["alias", "list"],
    ["pin", "bad"],
    ["pin", "add"],
    ["pin", "list", "extra"],
    ["pin", "add", "name", another, "--replace"],
    ["pin", "add", "bad/name", another],
    ["pin", "rename", "name", "1bad"],
    ["pin", "list", "--kind", "content"],
    ["pin", "list", "--kind"],
    ["register", "set", schema, another, "--"],
    ["register", "set", schema, another, "--", "--cid=%"],
    ["config", "show"],
    ["config", "set", "history.limit", "0"],
    ["config", "get", "unknown"],
    ["history", "remove"],
    ["history", "remove", "--yes"],
    ["history", "remove", "id", "--status", "failed", "--yes"],
    ["history", "remove", "--status", "failed", "--limit", "1", "--yes"],
    ["history", "list", "--limit"],
    ["history", "list", "--limit", "0"],
    ["history", "show"],
    ["open", another, "--app", another],
  ])("syntax errors precede execution: %j", async (...args) => {
    const result = await cli(work.stateDir, args);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("Error:");
    expect(existsSync(work.stateDir)).toBe(false);
  });

  it("exec tail is wholly opaque, register separator differs", () => {
    expect(
      parse(["exec", another, "--help", "--cid", "--", "--json"]).positional,
    ).toEqual([another, "--help", "--cid", "--", "--json"]);
    expect(
      parse([
        "register",
        "set",
        schema,
        another,
        "--replace",
        "--",
        "--replace",
        "%",
      ]).template,
    ).toEqual(["--replace", "%"]);
    expect(() => help("unknown")).toThrow("Unknown command");
  });

  it("pin names resolve exact identities and legacy aliases stay untrusted", async () => {
    const state = new State(work.stateDir);
    seedDisplayPin(state, "a", schema);
    seedDisplayPin(state, "z", another);
    state.db.prepare("INSERT INTO aliases VALUES (?,?)").run("legacy", another);
    expect(state.resolve("a", true)).toBe(schema);
    expect(state.resolve("z")).toBe(another);
    expect(() => state.resolve("legacy")).toThrow("not a pin");
    state.close();
    const listed = await cli(work.stateDir, ["--json", "pin", "list"]);
    expect(JSON.parse(listed.out) as unknown).toMatchObject({
      items: [
        { name: "a", cid: schema },
        { name: "z", cid: another },
        ...builtinPins,
      ],
      legacyAliases: [{ name: "legacy", cid: another }],
    });
    expect(listed.err).toContain("not pinned");
    for (const name of ["1x", "../x", schema])
      expect(() => {
        pinName(name);
      }).toThrow();
    expect(() => exactCid("bad")).toThrow();
    expect(() => exactCid(another, true)).toThrow("DAG-CBOR");
    expect(() => exactCid("builtin:bundle-schema.v1", true)).toThrow(
      "valid CID",
    );
    expect(() =>
      exactCid(
        "bafybeidq5zd7tzccgueniq5fnv2yugw45ijmifw76sknpem7mz5jynmaxe",
        true,
      ),
    ).toThrow("DAG-CBOR");
    const reopened = new State(work.stateDir);
    expect(() => reopened.resolve("unknown")).toThrow("Unknown");
    expect(() => reopened.resolve(another, true)).toThrow("DAG-CBOR");
    expect(reopened.aliases()).toEqual([{ name: "legacy", cid: another }]);
    reopened.close();
  });

  it("builtin pins stay offline, are visible and cannot be changed", async () => {
    const listed = await cli(work.stateDir, ["pin", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(appBuiltinAlias);
    expect(listed.out).toContain("built-in (read-only)");
    expect(
      (await cli(work.stateDir, ["register", "set", appBuiltinAlias, another]))
        .out,
    ).toContain(schema);
    const state = new State(work.stateDir);
    expect(state.aliases()).toEqual([]);
    state.close();
    for (const args of [
      ["pin", "add", appBuiltinAlias, another],
      ["pin", "delete", appBuiltinAlias],
      ["pin", "rename", appBuiltinAlias, "new-name"],
      ["pin", "rename", "reader", appBuiltinAlias],
    ]) {
      const response = await cli(work.stateDir, args);
      expect(response.code).toBe(2);
    }
    expect(
      JSON.parse(
        (await cli(work.stateDir, ["--json", "pin", "list"])).out,
      ) as unknown,
    ).toEqual({ items: builtinPins, pending: [], legacyAliases: [] });
    const shown = await cli(work.stateDir, ["pin", "show", appBuiltinAlias]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("content bundled with IPAB");
  });

  it("registrations validate full-token templates and require deliberate replacement", async () => {
    expect((await cli(work.stateDir, ["--json", "register", "list"])).out).toBe(
      '{"items":[]}',
    );
    const command = ["--json", "register", "set", schema, another];
    expect((await cli(work.stateDir, command)).code).toBe(0);
    expect((await cli(work.stateDir, command)).code).toBe(0);
    expect(
      (await cli(work.stateDir, [...command, "--", "--cid", "%"])).code,
    ).toBe(1);
    expect(
      (
        await cli(work.stateDir, [
          ...command,
          "--replace",
          "--",
          "--cid",
          "%",
          "%",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await cli(work.stateDir, ["--json", "register", "remove", schema])).out,
    ).toBe(JSON.stringify({ removed: [schema] }));
    expect(
      (await cli(work.stateDir, ["register", "remove", schema])).code,
    ).toBe(1);
    const state = new State(work.stateDir);
    expect(() => state.setAssociation(schema, another, [], false)).toThrow(
      "template",
    );
    state.close();
  });

  it("config preserves types, precedence and only removes a single user override", async () => {
    for (const [key, value] of [
      ["history.enabled", "false"],
      ["history.limit", "37"],
      ["output.retention", "none"],
      ["store.rpc", "http://localhost:5001"],
    ]) {
      expect(
        (await cli(work.stateDir, ["config", "set", key!, value!])).code,
      ).toBe(0);
    }
    expect(
      (await cli(work.stateDir, ["--json", "config", "get", "history.enabled"]))
        .out,
    ).toBe(
      '{"items":[{"key":"history.enabled","value":false,"source":"user"}]}',
    );
    const masked = await cli(work.stateDir, [
      "--store-rpc",
      "http://localhost:6001",
      "--json",
      "config",
      "set",
      "store.rpc",
      "http://localhost:7001",
    ]);
    expect(masked.err).toContain("masked by flag");
    expect(masked.out).toContain('"source":"user"');
    const environment = await cli(
      work.stateDir,
      ["config", "set", "history.enabled", "true"],
      { env: { IPAB_HISTORY_ENABLED: "false" } },
    );
    expect(environment.err).toContain("masked by env");
    expect(
      (
        await cli(work.stateDir, ["--json", "config", "get", "store.rpc"], {
          env: { IPAB_STORE_RPC: "default" },
        })
      ).out,
    ).toContain('"value":null,"source":"env"');
    for (let index = 0; index < 2; index++)
      expect(
        (
          await cli(work.stateDir, [
            "--json",
            "config",
            "reset",
            "history.limit",
          ])
        ).out,
      ).toBe('{"reset":["history.limit"]}');
    const current = await cli(work.stateDir, ["--json", "config", "get"]);
    expect(current.out).toContain('"value":20,"source":"default"');
    expect(current.out).toContain('"value":"none"');
    expect(current.out).toContain('"key":"state-dir"');
    expect(
      (await cli(work.stateDir, ["--json", "config", "get", "state-dir"])).out,
    ).toContain('"source":"flag"');
    expect(
      (
        await cli(work.stateDir, ["config", "get"], {
          env: { IPAB_HISTORY_LIMIT: "oops" },
        })
      ).code,
    ).toBe(2);
  });

  it.each(["{bad", '"false"', "null"])(
    "malformed persisted config is never defaulted: %s",
    async (value) => {
      const state = new State(work.stateDir);
      state.db
        .prepare("INSERT INTO config VALUES (?,?)")
        .run("history.enabled", value);
      state.close();
      const result = await cli(work.stateDir, ["pin", "list"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("Malformed user configuration");
      expect(result.out).toBe("");
    },
  );

  it("typed config helpers reject unsupported/secret values without disclosing them", async () => {
    for (const url of [
      "https://user:secret@localhost",
      "http://localhost/?token=secret",
      "http://localhost/#secret",
      "ftp://localhost",
      "broken",
    ])
      expect(() => publicUrl(url)).toThrow("without credentials");
    expect(publicUrl("https://localhost")).toBe("https://localhost/");
    expect(() => configKey("state-dir")).toThrow();
    for (const [key, value] of [
      ["history.enabled", 0],
      ["history.limit", -1],
      ["history.limit", "2.3"],
      ["output.retention", "keep"],
    ])
      expect(() => parseValue(configKey(String(key)), value, true)).toThrow();
    expect(parseValue("history.enabled", "true", true)).toBe(true);
    expect(parseValue("store.rpc", null)).toBeNull();
    expect(() => validateUserConfig({ unknown: true })).toThrow("Malformed");
    expect(() => validateUserConfig([])).toThrow("Invalid");
    expect(() => stateLocation({ json: false, stateDir: "" }, {})).toThrow();
    expect(
      stateLocation({ json: false }, { IPAB_STATE_DIR: work.stateDir }).source,
    ).toBe("env");
    expect(stateLocation({ json: false }, {}).source).toBe("default");
    expect(effectiveConfig({}, { json: false }, {}).at(-1)?.source).toBe(
      "default",
    );
    expect(await storeConfiguration("http://localhost:5001")).toEqual({
      backend: "kubo",
      apiUrl: "http://localhost:5001/",
    });
    expect(
      message(new Error("http://user:secret@localhost/?token=secret")),
    ).not.toContain("secret");
    expect(message("bad")).toBe("Unknown operation failure.");
    expect(message(new Error("http://]"))).toBe("[redacted URL]");
    expect(() => object(null, "thing")).toThrow("Invalid thing");
    expect(new HostError("problem").name).toBe("HostError");
    let err = "";
    expect(
      await runCli(
        ["--store-rpc", "http://user:secret@localhost", "exec", schema],
        {
          out() {},
          err(text) {
            err = text;
          },
          tty: false,
          confirm: () => Promise.resolve(false),
        },
        {},
      ),
    ).toBe(2);
    expect(err).not.toContain("secret");
    expect(existsSync(join(work.stateDir, "runtime"))).toBe(false);
  });

  it("uses public local Store configuration defaults and validates gateway URLs without probing", async () => {
    const path = join(work.root, "public-config.json");
    const previous = process.env.TASK_CONTENT_CONFIG;
    process.env.TASK_CONTENT_CONFIG = path;
    try {
      const missing = await storeConfiguration(null);
      expect(missing.backend).toBe("local");
      await writeFile(
        path,
        JSON.stringify({
          ...work.store.configuration,
          gateway: ["https://gateway.example", "https://second.example"],
        }),
      );
      expect((await storeConfiguration(null)).backend).toBe("local");
      await writeFile(
        path,
        JSON.stringify({
          ...work.store.configuration,
          gateway: "https://gateway.example",
        }),
      );
      expect((await storeConfiguration(null)).backend).toBe("local");
      await writeFile(
        path,
        JSON.stringify({
          ...work.store.configuration,
          gateway: "https://user:secret@gateway.example",
        }),
      );
      await expect(storeConfiguration(null)).rejects.toThrow(
        "without credentials",
      );
      expect(parseValue("output.retention", "history")).toBe("history");
      expect(() => parseValue("store.rpc", 123)).toThrow("Invalid value");
      expect(() =>
        parseValue("history.limit", Number.MAX_SAFE_INTEGER + 1),
      ).toThrow("positive");
      expect(() => validateUserConfig({ "history.limit": "20" })).toThrow(
        "Malformed",
      );
      expect(() =>
        stateLocation({ json: false }, { IPAB_STATE_DIR: "" }),
      ).toThrow("nonempty");
    } finally {
      if (previous === undefined) delete process.env.TASK_CONTENT_CONFIG;
      else process.env.TASK_CONTENT_CONFIG = previous;
    }
  });
});
