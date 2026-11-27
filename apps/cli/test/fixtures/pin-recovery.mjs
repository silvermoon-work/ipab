import { IpfsStore } from "@ipab/ipfs-store";
import { addPin } from "../../dist/pins.js";
import { State } from "../../dist/state.js";

const [stateDir, root, configuration] = process.argv.slice(2);
await addPin(
  new State(stateDir),
  "interrupted",
  root,
  JSON.parse(configuration),
  (config) => {
    const store = new IpfsStore(config);
    store.confirmRetained = () => process.exit(42);
    return store;
  },
);
