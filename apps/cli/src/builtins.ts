import { builtinAppSchema } from "./app-definition.js";
import {
  builtinTemplateSchema,
  templateSchemaCid,
} from "./template-definition.js";
import { builtinTemplateNames } from "./app-templates.js";
import { builtinTemplateSource } from "./template-source.js";
import { openBundle } from "@ipab/bundle";
import { fileURLToPath } from "node:url";
import { readCar } from "./authoring.js";
import type { NamedPin, PinMetadata } from "./state.js";

async function loadBuiltins(): Promise<{
  pins: readonly NamedPin[];
  blocks: ReadonlyMap<string, Uint8Array>;
}> {
  const pins: NamedPin[] = [];
  const blocks = new Map<string, Uint8Array>();
  const add = (name: string, cid: string, metadata: PinMetadata) => {
    pins.push({
      name,
      cid,
      owner: name,
      status: "ready",
      metadata,
      builtin: true,
    });
  };
  for (const schema of [
    await builtinAppSchema(),
    await builtinTemplateSchema(),
  ]) {
    const cid = schema.cid.toString();
    blocks.set(cid, schema.bytes);
  }
  for (const [name, selector] of builtinTemplateNames) {
    const template = await builtinTemplateSource(selector);
    for (const [cid, bytes] of template.blocks) blocks.set(cid, bytes);
    add(name, template.cid, {
      kind: "bundle",
      title: template.manifest.title,
      schemaCid: templateSchemaCid.toString(),
    });
  }
  const skill = await readCar(
    fileURLToPath(new URL("../dist/builtins/skill.ipab.car", import.meta.url)),
    {},
  );
  const bundle = await openBundle(skill.root, { resolveCid: skill.resolveCid });
  if (
    bundle.manifest.entry !== "SKILL.md" ||
    bundle.schema.type.contentType !== "text/markdown" ||
    bundle.validation.status !== "validated"
  )
    throw new Error(
      "Built-in IPAB Skill must be a validated Markdown Skill Bundle.",
    );
  for (const [cid, bytes] of skill.blocks) blocks.set(cid, bytes);
  add("builtin:skill.ipab", skill.root.toString(), {
    kind: "bundle",
    title: bundle.manifest.title,
    schemaCid: bundle.schemaKey,
  });
  return { pins, blocks };
}

let loaded: ReturnType<typeof loadBuiltins> | undefined;
export function builtinContent() {
  return (loaded ??= loadBuiltins());
}
