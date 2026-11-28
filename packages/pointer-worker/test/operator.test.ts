import { describe, expect, it } from "vitest";
import { runOperator } from "../src/operator.ts";
import {
  ScopeClient,
  uniqueId,
  verifyScopeCertificate,
} from "@ipab/bundle/pointer/scope";
import {
  API_KEY,
  SERVICE,
  generateKeyPair,
  createScopeService,
} from "./helpers.ts";

describe("Scope operator", { tags: ["mock"] }, () => {
  it("executes protected Owner allocation/CAS/lifecycle while public reads need no keystore", async () => {
    const service = await createScopeService(),
      owner = await generateKeyPair();
    const files = new Map([
      [
        "owner",
        JSON.stringify({
          publicKey: owner.publicRaw,
          privateKey: owner.privatePkcs8,
        }),
      ],
      [
        "config",
        JSON.stringify({
          "pointers.service": SERVICE,
          "pointers.apiKey": API_KEY,
        }),
      ],
    ]);
    const output: string[] = [];
    const io = {
      env: {},
      fetch: service.fetch,
      print: (text: string) => {
        output.push(text);
      },
      read: (path: string) => Promise.resolve(files.get(path) ?? ""),
      save: (path: string, text: string) => {
        files.set(path, text);
        return Promise.resolve();
      },
    };
    await runOperator(
      ["create-scope", "--key", "owner", "--config-file", "config"],
      io,
    );
    const scope = (JSON.parse(output.at(-1)!) as { id: string }).id;
    await runOperator(
      [
        "create",
        "--key",
        "owner",
        "--service",
        SERVICE,
        "--scope",
        scope,
        "--value",
        '{"value":"A"}',
      ],
      io,
    );
    const initial = JSON.parse(output.at(-1)!) as { id: string; cid: string };
    const shared = ["--service", SERVICE, "--scope", scope, "--id", initial.id];
    await runOperator(["read", ...shared], io);
    expect(JSON.parse(output.at(-1)!) as unknown).toMatchObject({
      value: { value: "A" },
      status: "writable",
    });
    await runOperator(
      [
        "write",
        "--key",
        "owner",
        ...shared,
        "--value",
        '{"value":"B"}',
        "--if-cid",
        initial.cid,
        "--idempotency-key",
        uniqueId(),
      ],
      io,
    );
    await runOperator(["freeze", "--key", "owner", ...shared], io);
    expect(JSON.parse(output.at(-1)!) as unknown).toMatchObject({
      value: { value: "B" },
      status: "frozen",
    });
    await runOperator(["delete", "--key", "owner", ...shared], io);
    await expect(runOperator(["read", ...shared], io)).rejects.toMatchObject({
      status: 410,
    });
    await runOperator(["keygen", "--out", "new-key"], io);
    expect(files.get("new-key")).toContain("privateKey");
    expect(output.at(-1)).toMatch(/^public key:/);
  });
  it("issues exact nonexpiring subject grants without asking for the member private key", async () => {
    const service = await createScopeService(),
      owner = await generateKeyPair(),
      member = await generateKeyPair();
    const client = new ScopeClient({
      service: SERVICE,
      apiKey: API_KEY,
      fetch: service.fetch,
      signer: { publicKey: owner.publicRaw, privateKey: owner.privatePkcs8 },
    });
    const scope = await client.createScope(uniqueId()),
      variable = await client.create(scope.id, null, uniqueId());
    let encoded = "";
    await runOperator(
      [
        "certify",
        "--issuer",
        "owner",
        "--subject",
        member.publicRaw,
        "--scope",
        scope.id,
        "--write",
        variable.id,
        "--service",
        SERVICE,
        "--out",
        "certificate",
      ],
      {
        env: {},
        print: () => {},
        read: () =>
          Promise.resolve(
            JSON.stringify({
              publicKey: owner.publicRaw,
              privateKey: owner.privatePkcs8,
            }),
          ),
        save: (_path, text) => {
          encoded = text;
          return Promise.resolve();
        },
      },
    );
    await verifyScopeCertificate(
      JSON.parse(encoded) as unknown,
      owner.publicRaw,
      SERVICE,
      scope.id,
      variable.id,
      member.publicRaw,
    );
    expect(encoded).not.toContain(member.privatePkcs8);
    expect(encoded).not.toContain('"exp"');
  });
  it("rejects foreign-origin creation, invalid protected input, delegation and obsolete flags", async () => {
    const owner = await generateKeyPair();
    const io = {
      env: { IPAB_POINTERS_SERVICE: SERVICE, IPAB_POINTERS_API_KEY: API_KEY },
      print: () => {},
      read: () =>
        Promise.resolve(
          JSON.stringify({
            publicKey: owner.publicRaw,
            privateKey: owner.privatePkcs8,
          }),
        ),
    };
    await expect(
      runOperator(
        [
          "create-scope",
          "--key",
          "owner",
          "--service",
          "https://foreign.example",
        ],
        io,
      ),
    ).rejects.toThrow("bound");
    await expect(runOperator(["unknown"], io)).rejects.toThrow("commands");
    await expect(runOperator(["create-scope"], io)).rejects.toThrow("--key");
    await expect(
      runOperator(["read", "--config-file", "config"], {
        ...io,
        read: () => Promise.resolve("[]"),
      }),
    ).rejects.toThrow("object");
    await expect(
      runOperator(["create-scope", "--key", "owner"], {
        ...io,
        read: () => Promise.resolve("{}"),
      }),
    ).rejects.toThrow("keystore");
    await expect(
      runOperator(["certify", "--issuer", "member"], {
        ...io,
        read: () =>
          Promise.resolve(
            JSON.stringify({
              publicKey: owner.publicRaw,
              privateKey: owner.privatePkcs8,
              certificate: {},
            }),
          ),
      }),
    ).rejects.toThrow("Owner");
    await expect(runOperator(["certify", "--days", "7"], io)).rejects.toThrow();
  });
});
