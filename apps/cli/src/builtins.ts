import { CarBlockIterator } from "@ipld/car/iterator";
import { encodeBundleCar, streamChunks } from "@ipab/bundle-builder";
import { appBuiltinAlias, builtinAppSchema } from "./app-definition.js";
import {
  builtinTemplateSchema,
  templateBuiltinAlias,
  templateSchemaCid,
} from "./template-definition.js";
import { builtinTemplateNames, builtinTemplateTree } from "./app-templates.js";
import type { NamedPin, PinMetadata } from "./state.js";
import { HostError } from "./errors.js";

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
    const tree = await builtinTemplateTree(selector);
    const encoded = await encodeBundleCar(tree);
    try {
      if (!encoded.schema.cid.equals(templateSchemaCid))
        throw new HostError("Built-in template has an unexpected Bundle type.");
      const car = await CarBlockIterator.fromIterable(
        streamChunks(encoded.stream),
      );
      for await (const block of car)
        blocks.set(block.cid.toV1().toString(), block.bytes);
      add(name, encoded.cid.toString(), {
        kind: "bundle",
        typeName: encoded.schema.manifest.name,
        schemaCid: encoded.schema.cid.toString(),
      });
    } finally {
      await encoded.close();
    }
  }
  return { pins, blocks };
}

let loaded: ReturnType<typeof loadBuiltins> | undefined;
export function builtinContent() {
  return (loaded ??= loadBuiltins());
}
