import type { CID } from "multiformats/cid";

export type JsonSchema = boolean | { readonly [key: string]: unknown };
export type ContentType =
  "application/json" | "application/yaml" | "application/jsonl";
export interface BundleManifest {
  readonly entry: {
    readonly path: string;
    readonly schemaCid: string;
    readonly contentType: ContentType;
  };
}
export interface SchemaDefinitions {
  readonly schema: JsonSchema;
  readonly definitions: ReadonlyMap<string, JsonSchema>;
}
export interface SchemaBlock extends SchemaDefinitions {
  readonly cid: CID;
  readonly bytes: Uint8Array;
}
export interface BundleLimits {
  bytes: number;
  blocks: number;
  blockBytes: number;
  parsingBytes: number;
  files: number;
  depth: number;
  jsonDepth: number;
  validationDepth: number;
  manifestBytes: number;
  schemaBytes: number;
  documentBytes: number;
  nodes: number;
}
export interface OpenBundleOptions {
  resolveCid(cid: CID, options: { signal?: AbortSignal }): Promise<Uint8Array>;
  signal?: AbortSignal;
  limits?: Partial<BundleLimits>;
}
export interface ContentBundle {
  readonly kind: "content";
  readonly cid: CID;
  readonly manifest: BundleManifest;
  readonly schemaKey: string;
  readonly schema: SchemaBlock;
  readFile(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
}
export type ContentBundleErrorCode =
  | "MANIFEST_INVALID"
  | "PATH_INVALID"
  | "REFERENCE_INVALID"
  | "SCHEMA_INVALID"
  | "CONTENT_INVALID"
  | "CONTENT_UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "OPTIONS_INVALID"
  | "ABORTED";
