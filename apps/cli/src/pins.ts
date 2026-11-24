import { randomUUID } from "node:crypto";
import { CID } from "multiformats/cid";
import { IpfsStore } from "@ipab/ipfs-store";
import { declaresBundleSchema, openBundle, openSchema } from "@ipab/bundle";
import { HostError, message } from "./errors.js";
import { alive, type StoreFactory } from "./history.js";
import {
  exactCid,
  pinName,
  type NamedPin,
  type PinMetadata,
  type State,
} from "./state.js";

export function pinDetails(pin: NamedPin) {
  if (pin.status !== "ready" || !pin.metadata)
    throw new HostError(
      `Pin "${pin.name}" is ${pin.status}. Retry ipab pin add ${pin.name} ${pin.cid}, or ipab pin delete ${pin.name}.`,
    );
  return { name: pin.name, cid: pin.cid, ...pin.metadata };
}

function requiredPin(state: State, name: string): NamedPin {
  pinName(name);
  const pin = state.pin(name);
  if (!pin)
    throw new HostError(`Pin "${name}" does not exist. Run ipab pin list.`);
  return pin;
}

function idleHold(state: State, pin: NamedPin) {
  const hold = state.hold(pin.owner);
  if (!hold)
    throw new HostError(
      "Pin retention metadata is missing; recovery is blocked.",
    );
  if (hold.pid !== null && alive(hold.pid))
    throw new HostError(
      `Pin "${pin.name}" has an active operation; retry after it finishes.`,
    );
  return hold;
}

async function classify(cid: string, store: IpfsStore): Promise<PinMetadata> {
  const root = CID.parse(cid);
  const resolveCid = (cid: CID, options: { signal?: AbortSignal }) =>
    store.block.get(cid.toString(), options);
  if (root.code === 0x71 && declaresBundleSchema(await store.block.get(cid))) {
    const schema = await openSchema(root, { resolveCid });
    return {
      kind: "schema",
      typeName: schema.manifest.name,
      schemaCid: schema.cid.toString(),
    };
  }
  if (root.code === 0x70) {
    const node = await store.read(root);
    if (node.type === "directory") {
      for await (const entry of node.entries()) {
        if (entry.name === ".bundle.yaml") {
          const bundle = await openBundle(root, { resolveCid });
          return {
            kind: "bundle",
            typeName: bundle.manifest.name,
            schemaCid: bundle.schemaKey,
          };
        }
      }
    }
  }
  return { kind: "content", typeName: null, schemaCid: null };
}

export async function addPin(
  state: State,
  name: string,
  input: string,
  configuration: IpfsStore["configuration"],
  factory: StoreFactory = (config) => new IpfsStore(config),
) {
  pinName(name);
  const cid = exactCid(input);
  const pin = state.transaction(() => {
    const old = state.pin(name);
    if (old) {
      if (old.status !== "pending" || old.cid !== cid)
        throw new HostError(
          `Pin name "${name}" is occupied; no replace is supported.`,
        );
      const hold = idleHold(state, old);
      state.saveHold({ ...hold, pid: process.pid });
      return old;
    }
    const owner = `ipab:${state.identity}:pin:${randomUUID()}`;
    const reserved: NamedPin = {
      name,
      cid,
      owner,
      status: "pending",
      metadata: null,
    };
    state.savePin(reserved);
    // Reserve the name and original backend before any Store side effect.
    state.saveHold({
      owner,
      backend: configuration,
      roots: [],
      pid: process.pid,
      session: null,
      recordId: null,
    });
    return reserved;
  });
  let store: IpfsStore | undefined;
  let finished = false;
  try {
    store = factory(state.hold(pin.owner)!.backend);
    await store.recoverOwner(pin.owner, () => state.hold(pin.owner)!.roots);
    await store.retain(pin.owner, [cid]);
    const metadata = await classify(cid, store);
    state.transaction(() => {
      state.savePin({ ...pin, metadata });
      state.saveHold({ ...state.hold(pin.owner)!, roots: [cid] });
    });
    await store.confirmRetained(pin.owner, [cid]);
    await store.close();
    store = undefined;
    const ready: NamedPin = { ...pin, status: "ready", metadata };
    state.transaction(() => {
      state.savePin(ready);
      state.saveHold({ ...state.hold(pin.owner)!, pid: null });
    });
    finished = true;
    return pinDetails(ready);
  } catch (cause) {
    throw new HostError(
      `Pin add incomplete for "${name}": ${message(cause)}. Durable recovery data is preserved; retry the same add or delete this pending pin.`,
      1,
      "PIN_INCOMPLETE",
    );
  } finally {
    try {
      await store?.close();
    } finally {
      const hold = state.hold(pin.owner);
      if (hold && !finished) state.saveHold({ ...hold, pid: null });
    }
  }
}

export async function deletePin(
  state: State,
  name: string,
  factory: StoreFactory = (config) => new IpfsStore(config),
) {
  const pin = state.transaction(() => {
    const pin = requiredPin(state, name);
    const hold = idleHold(state, pin);
    state.savePin({ ...pin, status: "deleting" });
    state.saveHold({ ...hold, roots: [], pid: process.pid });
    return pin;
  });
  let store: IpfsStore | undefined;
  try {
    store = factory(state.hold(pin.owner)!.backend);
    await store.recoverOwner(pin.owner, () => state.hold(pin.owner)!.roots);
    await store.reconcile(pin.owner, () => state.hold(pin.owner)!.roots);
    await store.close();
    store = undefined;
    state.transaction(() => {
      state.deletePin(name);
      state.deleteHold(pin.owner);
    });
    return {
      removed: [name],
      retentionClaimsReleased: true,
      garbageCollectionGuaranteed: false,
    };
  } catch (cause) {
    throw new HostError(
      `Pin deletion incomplete for "${name}": ${message(cause)}. Retry ipab pin delete ${name}; original backend and recovery data are preserved. No GC requested.`,
      1,
      "RELEASE_FAILED",
      "cleanup",
    );
  } finally {
    try {
      await store?.close();
    } finally {
      const hold = state.hold(pin.owner);
      if (hold) state.saveHold({ ...hold, pid: null });
    }
  }
}

export function renamePin(state: State, oldName: string, newName: string) {
  pinName(newName);
  return state.transaction(() => {
    const pin = requiredPin(state, oldName);
    const details = pinDetails(pin);
    idleHold(state, pin);
    if (oldName === newName) return details;
    if (state.pin(newName))
      throw new HostError(`Pin name "${newName}" is occupied.`);
    state.deletePin(oldName);
    state.savePin({ ...pin, name: newName });
    return { ...details, name: newName };
  });
}
