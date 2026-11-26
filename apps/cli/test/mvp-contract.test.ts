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
  },
);
