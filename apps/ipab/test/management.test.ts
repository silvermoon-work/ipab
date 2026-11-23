import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { aliasName, exactCid, State } from "../src/state.js";
import { appSchemaBlock } from "../src/space.js";
import { fixture, cli, record, importFiles } from "./helpers.js";

describe("management contract", () => {
  let work: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    work = await fixture();
  });
  afterEach(async () => {
    await work.cleanup();
  });
  const schema = appSchemaBlock.cid.toString();
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
      /^RUN ID\s+ENDED\s+STATUS\s+APP CID\s+OUTPUT CID\s+ARGV\nrun-002/,
    );
    expect(page.out).toContain(output);
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
    expect(() => exactCid(another, true)).toThrow("DAG-CBOR");
    const state = new State(work.stateDir);
    expect(() => state.resolve("unknown")).toThrow("Unknown");
    expect(() => state.resolve(another, true)).toThrow("DAG-CBOR");
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
