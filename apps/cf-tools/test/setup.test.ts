import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withInstallation } from "../src/setup.js";
import { spawn } from "node:child_process";
import { once } from "node:events";

const cid = "bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq";
const roots: string[] = [];
describe(
  "installation lock process lifetime",
  { tags: ["release-e2e"] },
  () => {
    it("allows concurrent readers, rejects reinstall and releases the running lock after forced exit", async () => {
      const root = await mkdtemp(join(tmpdir(), "ipab-lock-crash-test-"));
      roots.push(root);
      vi.stubEnv("IPAB_APP_INSTALL_ROOT", root);
      const files = {
        appCid: cid,
        readFile: () =>
          Promise.resolve(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.from("{}"));
                controller.close();
              },
            }),
          ),
      };
      const install = vi.fn(() => Promise.resolve());
      const directory = await withInstallation(
        files,
        false,
        (path) => Promise.resolve(path),
        install,
      );
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
      const {DatabaseSync}=require("node:sqlite");
      const db=new DatabaseSync(process.argv[1]);
      db.exec("BEGIN");
      db.prepare("SELECT name FROM sqlite_schema").all();
      process.send("locked");
      setInterval(()=>{},1000);
    `,
          join(directory, "..", "installation-lock.sqlite"),
        ],
        {
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      try {
        await once(child, "message");
        await expect(
          withInstallation(files, false, () => Promise.resolve(), install),
        ).resolves.toBeUndefined();
        await expect(
          withInstallation(files, true, () => Promise.resolve(), install),
        ).rejects.toThrow("busy");
      } finally {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
      await expect(
        withInstallation(files, true, () => Promise.resolve(), install),
      ).resolves.toBeUndefined();
      expect(install).toHaveBeenCalledTimes(2);
    }, 10_000);
  },
);
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("self-installing App cache", { tags: ["mock"] }, () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "ipab-setup-test-"));
    roots.push(root);
    vi.stubEnv("IPAB_APP_INSTALL_ROOT", root);
    const reads = vi.fn(() =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("{}"));
            controller.close();
          },
        }),
      ),
    );
    const files = { appCid: cid, readFile: reads };
    const install = vi.fn(
      async (_entry: string, args: string[], cwd: string) => {
        expect(args).toEqual([
          "--config.manage-package-manager-versions=false",
          "install",
          "--frozen-lockfile",
          "--prod",
        ]);
        await writeFile(join(cwd, "program.js"), "original");
      },
    );
    return { root, files, reads, install };
  }

  it("installs once, trusts modified ready caches, and reinstall restores payload", async () => {
    const { files, reads, install } = await fixture();
    const path = await withInstallation(
      files,
      false,
      (directory) => Promise.resolve(directory),
      install,
    );
    await writeFile(join(path, "program.js"), "modified");
    await withInstallation(
      files,
      false,
      async (directory) => {
        expect(await readFile(join(directory, "program.js"), "utf8")).toBe(
          "modified",
        );
      },
      install,
    );
    expect(install).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(3);
    await withInstallation(
      files,
      true,
      async (directory) => {
        expect(await readFile(join(directory, "program.js"), "utf8")).toBe(
          "original",
        );
      },
      install,
    );
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed installations and preserves ready cache after failed reinstall", async () => {
    const { files, install } = await fixture();
    const fail = vi.fn(() => Promise.reject(new Error("installation failed")));
    await expect(
      withInstallation(files, false, async () => {}, fail),
    ).rejects.toThrow("installation failed");
    const path = await withInstallation(
      files,
      false,
      (directory) => Promise.resolve(directory),
      install,
    );
    await expect(
      withInstallation(files, true, async () => {}, fail),
    ).rejects.toThrow("installation failed");
    expect(await readFile(join(path, "program.js"), "utf8")).toBe("original");
    await withInstallation(files, false, async () => {}, install);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("prevents reinstall while a running App uses its installation", async () => {
    const { files, install } = await fixture();
    await withInstallation(
      files,
      false,
      async () => {
        await expect(
          withInstallation(files, false, async () => {}, install),
        ).resolves.toBeUndefined();
        await expect(
          withInstallation(files, true, async () => {}, install),
        ).rejects.toThrow("busy");
      },
      install,
    );
    await expect(
      withInstallation(files, false, async () => {}, install),
    ).resolves.toBeUndefined();
  });
});
