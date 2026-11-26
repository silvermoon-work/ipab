/// <reference types="@cloudflare/workers-types" />

import type { PointerObject } from "./src/pointer-object.ts";
import type { RegistryObject } from "./src/registry-object.ts";

declare global {
  interface Env {
    POINTER: DurableObjectNamespace<PointerObject>;
    REGISTRY: DurableObjectNamespace<RegistryObject>;
    POINTER_SERVICE: string;
    POINTER_API_KEY_SHA256?: string;
    ALLOWED_ORIGIN?: string;
  }
}

export {};
