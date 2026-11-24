import type { CID } from "multiformats/cid";

export type JsonSchema = boolean | { readonly [key: string]: unknown };
export type ContentType =
  "application/json" | "application/yaml" | "application/jsonl";
export interface BundleManifest {
  readonly entry: {
    readonly path: string;
    readonly schema: string;
    readonly contentType: ContentType;
  };
}
export interface SchemaDescriptor {
  readonly schemas: readonly string[];
  readonly main: string;
  readonly title?: string;
  readonly description?: string;
}
export interface SchemaDefinitions {
  readonly descriptor: SchemaDescriptor;
  readonly definitions: ReadonlyMap<string, JsonSchema>;
}
export interface SchemaBundle extends ContentBundle, SchemaDefinitions {
  readonly kind: "schema";
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
  descriptorBytes: number;
  schemaBytes: number;
  documentBytes: number;
  schemas: number;
  nodes: number;
}
export interface OpenBundleOptions {
  resolveCid(cid: CID, options: { signal?: AbortSignal }): Promise<Uint8Array>;
  signal?: AbortSignal;
  limits?: Partial<BundleLimits>;
}
export interface ContentBundle {
  readonly kind: "content" | "schema";
  readonly cid: CID;
  readonly manifest: BundleManifest;
  /** Registry key: the embedded directory CID, or the fixed builtin profile. */
  readonly schemaKey: string;
  readonly schemaBundle?: SchemaBundle;
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
