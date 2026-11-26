import { it, expect } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCli, type IO } from "../src/cli.js";
import { pointersConfig } from "../src/pointers-config.js";
import { randomBytes, toBase64Url } from "@ipab/bundle/pointer/crypto";

it(
  "protects API-key stdin cfg, masks queries, rejects argument secrets and prevents origin retargeting",
  { tags: ["release-e2e"], timeout: 60_000 },
  async () => {
    const base = resolve(".test-work");
    await mkdir(base, { recursive: true });
    const home = await mkdtemp(join(base, "pointers-cfg-"));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const apiKey = toBase64Url(randomBytes(32));
    let out = "",
      err = "";
    const io: IO = {
      out: (value) => {
        out += value;
      },
      err: (value) => {
        err += value;
      },
      tty: false,
      confirm: () => Promise.resolve(false),
      readSecret: () => Promise.resolve(apiKey),
    };
    const call = async (args: string[]) => {
      out = "";
      err = "";
      const code = await runCli(["--json", ...args], io, env);
      expect(out.includes(apiKey) || err.includes(apiKey)).toBe(false);
      return { code, out, err };
    };
    try {
      expect(
        (
          await call([
            "config",
            "set",
            "pointers.service",
            "https://pointers.example",
          ])
        ).code,
      ).toBe(0);
      expect(
        (await call(["config", "set", "pointers.apiKey", "--stdin"])).code,
      ).toBe(0);
      expect((await pointersConfig(env)).apiKey === apiKey).toBe(true);
      const query = await call(["config", "get", "pointers.apiKey"]);
      expect(JSON.parse(query.out)).toMatchObject({
        configured: true,
        value: "[redacted]",
        service: "https://pointers.example",
      });
      expect(
        (await call(["config", "set", "pointers.apiKey", apiKey])).code,
      ).toBe(2);
      expect(
        (
          await call([
            "config",
            "set",
            "pointers.service",
            "https://foreign.example",
          ])
        ).code,
      ).toBe(1);
      expect((await pointersConfig(env)).service).toBe(
        "https://pointers.example",
      );
      expect((await call(["config", "reset", "pointers.apiKey"])).code).toBe(0);
      expect(
        (
          await call([
            "config",
            "set",
            "pointers.service",
            "https://foreign.example",
          ])
        ).code,
      ).toBe(0);
      expect((await pointersConfig(env)).apiKey).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
