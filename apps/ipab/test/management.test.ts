import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import stringWidth from "string-width";
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
import { aliasName, exactCid, State } from "../src/state.js";
import { appSchemaCid } from "../src/space.js";
import { fixture, cli, record, importFiles } from "./helpers.js";

describe("management contract", () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    work = await fixture();
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
    state.setAlias("reader", another, false);
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
    const aliases = await cli(work.stateDir, ["alias", "list"]);
    expect(aliases.out).toMatch(/^NAME\s+CID\nreader\s+/);
    expect(aliases.out).toContain(another);
    expect(
      JSON.parse(
        (await cli(work.stateDir, ["--json", "alias", "list"])).out,
      ) as unknown,
    ).toEqual({ items: [{ name: "reader", cid: another }] });
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
    expect(page.out).toMatch(
      /^RUN ID\s+ENDED\s+STATUS\s+APP\s+OUTPUT\s+ARGV\nrun-002/,
    );
    expect(page.out).toContain("reader");
    expect(page.out).toContain(`${output.slice(0, 13)}...`);
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
      [aliases, registered, config, page, details, retained].every(
        (result) => result.err === "",
      ),
    ).toBe(true);
  });

  it("history lists current aliases and readable quoted arguments without changing full records", async () => {
    const argv = ["--flag", "two words", "", 'quote"x', "\n"];
    const state = new State(work.stateDir);
    state.setAlias("z-reader", another, false);
    state.setAlias("reader", another, false);
    state.setAlias("result", schema, false);
    state.saveRun(record("readable-run", another, { argv, outputCid: schema }));
    state.close();
    const result = await cli(work.stateDir, ["history", "list"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("reader");
    expect(result.out).toContain("result");
    expect(result.out).not.toContain("z-reader");
    expect(result.out).not.toContain(another);
    expect(result.out).not.toContain(schema);
    expect(result.out).toContain('--flag "two words" "" "quote\\"x" "\\n"');
    expect(result.out.split("\n")).toHaveLength(2);
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

  it("history limits references and argv at their display boundaries without splitting Unicode", async () => {
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
      const row = result.out
        .split("\n")
        .find((line) => line.startsWith(`run-${length}`));
      expect(row?.split(/\s{2,}/)).toEqual([
        `run-${length}`,
        expect.stringMatching(/^(?:\d+[mh]|\d{4}-\d{2}-\d{2})$/),
        "succeeded",
        `${another.slice(0, 13)}...`,
        `${schema.slice(0, 13)}...`,
        length <= 48 ? "x".repeat(length) : `${"x".repeat(45)}...`,
      ]);
    }
    const unicode = result.out
      .split("\n")
      .find((line) => line.startsWith("unicode-"));
    expect(unicode?.split(/\s{2,}/).at(-1)).toBe(
      `"${"\u{1f600}".repeat(44)}...`,
    );
    const updated = new State(work.stateDir);
    updated.setAlias("a-long-readable-app-name", another, false);
    updated.close();
    const aliased = await cli(work.stateDir, ["history", "list"]);
    expect(aliased.out).toContain("a-long-readab...");
    expect(aliased.out).not.toContain("a-long-readable-app-name");
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
    expect(page.out).toMatch(/\n01234567-a\s/);
    expect(page.out).toContain("use --before 01234567-a with the same filters");
    expect(page.out).not.toContain(firstId);
    const next = await cli(work.stateDir, [
      "history",
      "list",
      "--before",
      "01234567-a",
    ]);
    expect(next.out).toMatch(/\n01234567-b\s/);
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

  it("history argv uses the terminal's remaining columns and grows on wider terminals", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-23T12:00:00Z"));
    const argv = ["--flag", "x".repeat(90)];
    const state = new State(work.stateDir);
    state.saveRun(record("term-run", another, { argv, outputCid: schema }));
    state.close();
    let previous = 0;
    let fullWidth = 0;
    for (const columns of [70, 80, 120, 200]) {
      const result = await cli(work.stateDir, ["history", "list"], { columns });
      expect(result.code).toBe(0);
      const lines = result.out.split("\n");
      expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true);
      const shown = lines[1]?.split(/\s{2,}/).at(-1);
      expect(shown?.length).toBeGreaterThan(previous);
      previous = shown?.length ?? 0;
      if (columns === 200) {
        expect(shown).toBe(argv.join(" "));
        fullWidth = stringWidth(lines[1]!);
      } else expect(shown).toMatch(/\.\.\.$/);
    }
    const exact = await cli(work.stateDir, ["history", "list"], {
      columns: fullWidth,
    });
    expect(exact.out.split("\n")[1]).toHaveLength(fullWidth);
    expect(exact.out).toContain(argv.join(" "));
    const smaller = await cli(work.stateDir, ["history", "list"], {
      columns: fullWidth - 1,
    });
    expect(smaller.out.split("\n")[1]).toHaveLength(fullWidth - 1);
    expect(smaller.out).not.toContain(argv.join(" "));
    const narrow = await cli(work.stateDir, ["history", "list"], {
      columns: 10,
    });
    expect(narrow.code).toBe(0);
    expect(narrow.out).toContain(`${another.slice(0, 13)}...`);
    expect(
      narrow.out
        .split("\n")[1]
        ?.split(/\s{2,}/)
        .at(-1),
    ).toBe("-...");
    const machine = await cli(work.stateDir, ["--json", "history", "list"], {
      columns: 0,
    });
    expect(JSON.parse(machine.out) as unknown).toMatchObject({
      items: [{ argv }],
    });
    const invalid = await cli(work.stateDir, ["history", "list"], {
      columns: 0,
    });
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("Invalid terminal width");
  });

  it("terminal-width truncation counts wide glyphs and preserves complete grapheme clusters", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-23T12:00:00Z"));
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
    for (const [glyph, count] of [
      ["\u4f60", 6],
      [family, 6],
      ["e\u0301", 12],
    ] as const) {
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
      expect(
        result.out.split("\n").every((line) => stringWidth(line) <= 80),
      ).toBe(true);
      expect(
        result.out
          .split("\n")[1]
          ?.split(/\s{2,}/)
          .at(-1),
      ).toBe(`"${glyph.repeat(count)}...`);
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
      const row = listed.out.split("\n").find((line) => line.startsWith(id));
      expect(row?.split(/\s{2,}/)[1]).toBe(ended);
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
      ["alias", "No aliases."],
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
      "alias",
      "register",
      "config",
      "history",
      ...[
        "alias list",
        "alias set",
        "alias remove",
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
    for (const group of ["alias", "register", "config", "history", ""])
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
    ["alias", "bad"],
    ["alias", "set"],
    ["alias", "list", "extra"],
    ["alias", "set", "name", another, "--bad"],
    ["alias", "set", "name", another, "--replace", "--replace"],
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

  it("aliases are exact identities, idempotent and independent of registrations", async () => {
    expect((await cli(work.stateDir, ["--json", "alias", "list"])).out).toBe(
      '{"items":[]}',
    );
    for (const name of ["z", "a"]) {
      const result = await cli(work.stateDir, [
        "--json",
        "alias",
        "set",
        name,
        schema,
      ]);
      expect(JSON.parse(result.out) as unknown).toEqual({ name, cid: schema });
      expect(
        (await cli(work.stateDir, ["alias", "set", name, schema])).code,
      ).toBe(0);
    }
    expect(
      (await cli(work.stateDir, ["alias", "set", "a", another])).code,
    ).toBe(1);
    expect(
      (await cli(work.stateDir, ["--json", "register", "set", "a", "z"])).out,
    ).toBe(JSON.stringify({ schemaCid: schema, appCid: schema, argv: ["%"] }));
    expect(
      (await cli(work.stateDir, ["alias", "set", "z", another, "--replace"]))
        .code,
    ).toBe(0);
    expect(
      (await cli(work.stateDir, ["--json", "register", "list"])).out,
    ).toContain(`"appCid":"${schema}"`);
    const listed = await cli(work.stateDir, ["--json", "alias", "list"]);
    expect(JSON.parse(listed.out) as unknown).toEqual({
      items: [
        { name: "a", cid: schema },
        { name: "z", cid: another },
      ],
    });
    expect(
      (await cli(work.stateDir, ["--json", "alias", "remove", "z"])).out,
    ).toBe('{"removed":["z"]}');
    expect((await cli(work.stateDir, ["alias", "remove", "z"])).code).toBe(1);
    expect(
      (await cli(work.stateDir, ["alias", "set", "chain", "a"])).code,
    ).toBe(2);
    for (const name of ["1x", "../x", schema])
      expect(() => {
        aliasName(name);
      }).toThrow();
    expect(() => exactCid("bad")).toThrow();
    expect(() => exactCid(another, true)).toThrow("UnixFS directory");
    expect(exactCid("builtin:bundle-schema.v1", true)).toBe(
      "builtin:bundle-schema.v1",
    );
    const state = new State(work.stateDir);
    expect(() => state.resolve("unknown")).toThrow("Unknown");
    expect(() => state.resolve(another, true)).toThrow("UnixFS directory");
    state.close();
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
      const result = await cli(work.stateDir, ["alias", "list"]);
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
