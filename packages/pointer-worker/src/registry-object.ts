import { DurableObject } from "cloudflare:workers";

// Migration history preserves old allocations; new requests never route here.
export class RegistryObject extends DurableObject<Env> {}
