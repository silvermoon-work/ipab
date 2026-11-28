import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const names = JSON.parse(await readFile("smoke-packages.json", "utf8"));
assert.equal(names.length, 5);
for (const name of names) {
  const pkg = JSON.parse(
    await readFile(join("node_modules", name, "package.json"), "utf8"),
  );
  for (const subpath of Object.keys(pkg.exports)) {
    if (subpath === "./package.json") continue;
    await import(subpath === "." ? name : `${name}${subpath.slice(1)}`);
  }
  for (const entry of Object.values(pkg.bin ?? {})) {
    const result = spawnSync(
      process.execPath,
      [join("node_modules", name, entry), "--version"],
      { encoding: "utf8", shell: false, timeout: 30_000 },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version);
    if (name === "@ipab/cli") {
      const stateDir = await mkdtemp(join(tmpdir(), "ipab-builtin-smoke-"));
      try {
        const pins = spawnSync(
          process.execPath,
          [
            join("node_modules", name, entry),
            "--state-dir",
            stateDir,
            "--json",
            "pin",
            "list",
          ],
          { encoding: "utf8", shell: false, timeout: 30_000 },
        );
        if (pins.error) throw pins.error;
        assert.equal(pins.status, 0, pins.stderr);
        assert.ok(
          JSON.parse(pins.stdout).items.some(
            (pin) => pin.name === "builtin:skill.ipab" && pin.builtin === true,
          ),
        );
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }
  }
}
