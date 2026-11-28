import { DurableObject } from "cloudflare:workers";

// Keep the deployed class name and storage intact without serving the retired protocol.
export class PointerObject extends DurableObject<Env> {}
