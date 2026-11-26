import { readFile } from "node:fs/promises";
import { packageSmoke } from "./index.js";

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    if (!args.length || args.includes("--help") || args.includes("-h")) {
      console.log(
        "Usage: package-smoke --verify FILE.mjs [--allow-build PACKAGE]...\n\nPack non-private pnpm workspace packages, install tarballs in a temporary consumer,\nand run a standalone verification file there. This does not publish or build source.\nUse --allow-build to explicitly permit dependency install scripts.",
      );
      return 0;
    }
    if (args.length === 1 && args[0] === "--version") {
      const pkg = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      console.log(pkg.version);
      return 0;
    }
    let verify: string | undefined;
    const allowBuilds: string[] = [];
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`${flag} requires a value. Run package-smoke --help.`);
      if (flag === "--verify" && !verify) verify = value;
      else if (flag === "--allow-build") allowBuilds.push(value);
      else throw new Error(`Unknown or duplicate option: ${flag}.`);
    }
    if (!verify) throw new Error("Supply --verify FILE.mjs.");
    const pnpm = process.env.npm_execpath;
    if (!pnpm) throw new Error("Run package-smoke through pnpm.");
    const count = await packageSmoke({
      root: process.cwd(),
      verify,
      pnpm,
      allowBuilds,
    });
    console.log(
      `Package smoke passed: ${count} packages installed and verified.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
