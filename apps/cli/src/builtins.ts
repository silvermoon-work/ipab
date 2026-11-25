import { appBuiltinAlias, builtinAppSchema } from "./app-definition.js";
import {
  builtinTemplateSchema,
  templateBuiltinAlias,
  templateSchema,
  templateSchemaCid,
} from "./template-definition.js";
import { builtinTemplateNames } from "./app-templates.js";
import { builtinTemplateSource } from "./template-source.js";
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
  for (const [name, schema] of [
    [appBuiltinAlias, await builtinAppSchema()],
    [templateBuiltinAlias, await builtinTemplateSchema()],
  ] as const) {
    const cid = schema.cid.toString();
    blocks.set(cid, schema.bytes);
    add(name, cid, {
      kind: "schema",
      typeName: schema.manifest.name,
      schemaCid: cid,
    });
  }
  for (const [name, selector] of builtinTemplateNames) {
    const template = await builtinTemplateSource(selector);
    for (const [cid, bytes] of template.blocks) blocks.set(cid, bytes);
    add(name, template.cid, {
      kind: "bundle",
      typeName: templateSchema.name,
      schemaCid: templateSchemaCid.toString(),
    });
  }
  return { pins, blocks };
}

let loaded: ReturnType<typeof loadBuiltins> | undefined;
export function builtinContent() {
  return (loaded ??= loadBuiltins());
}
