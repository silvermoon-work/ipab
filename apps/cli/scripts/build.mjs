import { chmodSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const compilation = spawnSync(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve("typescript/bin/tsc")),
    "--project",
    "tsconfig.build.json",
  ],
  { stdio: "inherit", shell: false },
);
if (compilation.error) throw compilation.error;
process.exitCode = compilation.status ?? 1;
if (process.exitCode === 0) {
  const { buildBundle } = await import("../dist/authoring.js");
  const { builtinTemplateSource } = await import("../dist/template-source.js");
  const { builtinTemplateNames, renderTemplate } =
    await import("../dist/app-templates.js");
  const framework = JSON.parse(
    readFileSync(
      fileURLToPath(import.meta.resolve("@ipab/web-app/package.json")),
      "utf8",
    ),
  );
  for (const selector of builtinTemplateNames.values()) {
    const built = await buildBundle(
      fileURLToPath(
        new URL(`../../../templates/${selector}/`, import.meta.url),
      ),
      {
        output: fileURLToPath(
          new URL(`../dist/builtins/template.${selector}.car`, import.meta.url),
        ),
        replace: true,
      },
    );
    const template = await builtinTemplateSource(selector);
    if (template.cid !== built.cid)
      throw new Error(`Built-in ${selector} template CID does not match.`);
    await renderTemplate(template.tree, "template-check", {
      parameters:
        selector === "web-app" ? [`webAppDependency=${framework.version}`] : [],
    });
  }
  if (process.platform !== "win32") {
    const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    chmodSync(entry, statSync(entry).mode | 0o111);
  }
}
