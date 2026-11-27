import { describe, expect, it } from "vitest";
import { parse, help } from "../src/cli.js";
import {
  effectiveConfig,
  parseValue,
  validateUserConfig,
} from "../src/config.js";

describe(
  "MVP command and persisted configuration contracts",
  { tags: ["unit"] },
  () => {
    const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    it("parses explicit shared references/raw modes without leaking exec flags to the host", () => {
      expect(
        parse(["--swarm", cid, "exec", "name:apps/hello", "--raw"]).positional,
      ).toEqual(["name:apps/hello", "--raw"]);
      expect(() => parse(["exec", "--raw", cid])).toThrow("Expected APP");
      expect(
        parse(["get", "--raw", "name:apps/hello", "-o", "work"]).options,
      ).toEqual({ raw: true, output: "work" });
      expect(parse(["open", "--raw", "name:apps/hello"]).options.raw).toBe(
        true,
      );
      expect(() => parse(["build", "--with-source"])).toThrow("Unknown option");
      for (const path of [
        "swarm create",
        "swarm request",
        "swarm approve",
        "swarm join",
        "swarm status",
        "get",
        "publish",
      ])
        expect(help(path)).toContain("Examples:");
      expect(() => parse(["--owner", "key", "swarm", "create"])).toThrow(
        "Unknown global",
      );
    });
    it("round-trips stored swarm settings and honors flag/environment precedence", () => {
      const user = validateUserConfig({
        "swarm.default": parseValue("swarm.default", cid, true),
        "swarm.service": parseValue(
          "swarm.service",
          "https://pointer.example",
          true,
        ),
        "swarm.provider": parseValue(
          "swarm.provider",
          "http://127.0.0.1:5001",
          true,
        ),
      });
      expect(user["swarm.default"]).toBe(cid);
      expect(
        effectiveConfig(user, { json: false }, {}).find(
          (item) => item.key === "swarm.default",
        ),
      ).toMatchObject({ value: cid, source: "user" });
      expect(
        effectiveConfig(
          user,
          { json: false, swarm: cid },
          { IPAB_SWARM: cid },
        ).find((item) => item.key === "swarm.default"),
      ).toMatchObject({ value: cid, source: "flag" });
      expect(validateUserConfig({ "swarm.default": null })).toEqual({
        "swarm.default": null,
      });
      expect(() =>
        validateUserConfig({ "swarm.default": "not-a-cid" }),
      ).toThrow("Malformed");
    });
    it("keeps force options before exec's App boundary and parses swarm management/search", () => {
      expect(
        parse([
          "--swarm",
          "work",
          "exec",
          "--force",
          "--log",
          "name:apps/hello",
          "--force",
        ]).options,
      ).toEqual({ force: true, log: true });
      expect(
        parse(["exec", "--force", "name:apps/hello", "--force"]).positional,
      ).toEqual(["name:apps/hello", "--force"]);
      for (const command of ["get", "open", "search"])
        expect(parse([command, "--force", "hello"]).options.force).toBe(true);
      for (const command of ["exec", "get", "open", "search"])
        expect(() =>
          parse([command, "--force", "--no-force", "hello"]),
        ).toThrow("mutually exclusive");
      expect(() =>
        parse(["--swarm", "work", "search", "--current", "hello"]),
      ).toThrow("mutually exclusive");
      expect(
        parse(["swarm", "add", cid, "--alias", "work"]).options.alias,
      ).toBe("work");
      for (const path of [
        "swarm list",
        "swarm add",
        "swarm use",
        "swarm remove",
        "search",
      ])
        expect(help(path)).toContain("Examples:");
      expect(parse(["search", "--help"]).help).toBe(true);
    });
    it("validates cache configuration and resolves alias selection without hiding invalid lower layers", () => {
      expect(parseValue("swarm.cacheTtl", "0", true)).toBe(0);
      expect(parseValue("swarm.cacheTtl", "300", true)).toBe(300);
      expect(parseValue("swarm.cacheTtl", "default", true)).toBe(300);
      for (const value of [-1, 1.5, Infinity, 86401, null, "1e3"])
        expect(() => parseValue("swarm.cacheTtl", value, true)).toThrow(
          "0 to 86400",
        );
      expect(parseValue("swarm.forceRefresh", "true", true)).toBe(true);
      expect(() => parseValue("swarm.forceRefresh", "yes", true)).toThrow(
        "true or false",
      );
      const resolve = (alias: string) => {
        if (alias !== "work") throw new Error("Unknown alias");
        return cid;
      };
      expect(
        effectiveConfig({}, { json: false, swarm: "work" }, {}, resolve).find(
          (item) => item.key === "swarm.default",
        ),
      ).toMatchObject({ value: cid, source: "flag" });
      expect(() =>
        effectiveConfig(
          {},
          { json: false, swarm: "work" },
          { IPAB_SWARM: "unknown" },
          resolve,
        ),
      ).toThrow("Unknown alias");
    });
  },
);
