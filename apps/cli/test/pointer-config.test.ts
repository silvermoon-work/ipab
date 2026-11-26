import { describe, expect, it } from "vitest";
import {
  defaults,
  effectiveConfig,
  parseValue,
  pointerService,
  validateUserConfig,
  visibleConfig,
} from "../src/config.js";
import { parse } from "../src/cli.js";
import { readSecretStream } from "../src/config-secret.js";

describe("pointer configuration", { tags: ["unit"] }, () => {
  it("validates canonical HTTPS service origins, loopback development and nullable defaults", () => {
    expect(defaults["pointers.service"]).toBeNull();
    expect(defaults["pointers.apiKey"]).toBeNull();
    for (const service of [
      "https://pointer.example",
      "http://127.0.0.1:8787",
      "http://localhost:8787",
      "http://[::1]:8787",
    ]) {
      expect(pointerService(service)).toBe(service);
      expect(parseValue("pointers.service", service)).toBe(service);
    }
    for (const service of [
      "http://public.example",
      "https://pointer.example/",
      "https://pointer.example/path",
      "https://user:password@pointer.example",
      "https://pointer.example?q=x",
      "https://pointer.example#x",
      "https://POINTER.EXAMPLE",
      "https://pointer.example:443",
      "not-a-url",
    ])
      expect(() => pointerService(service)).toThrow();
    expect(parseValue("pointers.service", null)).toBeNull();
    expect(parseValue("pointers.service", "default", true)).toBeNull();
    expect(() => parseValue("pointers.service", 42)).toThrow(
      "Invalid pointers.service",
    );
  });
  it("accepts only canonical full API key encodings and never repeats invalid input in errors", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    expect(parseValue("pointers.apiKey", key)).toBe(key);
    expect(parseValue("pointers.apiKey", null)).toBeNull();
    expect(parseValue("pointers.apiKey", "default", true)).toBeNull();
    for (const value of [
      "private-invalid",
      "A".repeat(42),
      "A".repeat(42) + "B",
      `${key}=`,
      42,
    ]) {
      expect(() => parseValue("pointers.apiKey", value)).toThrow(
        "Invalid pointers.apiKey",
      );
    }
    expect(() =>
      validateUserConfig({ "pointers.apiKey": "private-invalid" }),
    ).toThrow("Malformed user configuration");
    expect(
      visibleConfig({ key: "pointers.apiKey", value: key, source: "user" }),
    ).toEqual({ key: "pointers.apiKey", value: "<redacted>", source: "user" });
    expect(
      visibleConfig({ key: "pointers.apiKey", value: null, source: "default" })
        .value,
    ).toBeNull();
    expect(
      visibleConfig({
        key: "pointers.service",
        value: "https://pointer.example",
        source: "user",
      }).value,
    ).toBe("https://pointer.example");
  });
  it("uses env over saved configuration and does not mask invalid lower layers", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const config = effectiveConfig(
      { "pointers.service": "https://saved.example", "pointers.apiKey": key },
      { json: true },
      {
        IPAB_POINTERS_SERVICE: "https://env.example",
        IPAB_POINTERS_API_KEY: key,
      },
    );
    expect(config.find((item) => item.key === "pointers.service")).toEqual({
      key: "pointers.service",
      value: "https://env.example",
      source: "env",
    });
    expect(config.find((item) => item.key === "pointers.apiKey")?.source).toBe(
      "env",
    );
    expect(() =>
      effectiveConfig(
        {},
        { json: true },
        { IPAB_POINTERS_API_KEY: "private-invalid" },
      ),
    ).toThrow("Invalid pointers.apiKey");
    expect(() => parse(["config", "set", "pointers.apiKey", key])).toThrow(
      "piped stdin",
    );
    expect(parse(["config", "set", "pointers.apiKey", "-"]).positional).toEqual(
      ["pointers.apiKey", "-"],
    );
  });
  it("bounds piped secret input before accumulating it and trims only transport whitespace", async () => {
    const input = (chunks: string[]): AsyncIterable<string> => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield await Promise.resolve(chunk);
      },
    });
    expect(
      await readSecretStream(input(["A".repeat(20), "A".repeat(23), "\r\n"])),
    ).toBe("A".repeat(43));
    await expect(
      readSecretStream(input(["A".repeat(64), "x"])),
    ).rejects.toThrow("exceeds 64 bytes");
    await expect(readSecretStream(input(["é".repeat(33)]))).rejects.toThrow(
      "exceeds 64 bytes",
    );
  });
});
