import { createRequire } from "node:module";
import { createContext, type AppContext, type Port } from "./context.js";

declare global {
  var ipab: AppContext;
}

const entry = process.argv[2];
if (!entry || !process.send || !process.channel)
  throw new Error("IPAB subprocess requires its dedicated context channel.");
const port: Port = {
  send(frame, callback) {
    process.send!(frame, callback);
  },
  on(event, listener) {
    process.on(event, listener);
  },
  off(event, listener) {
    process.off(event, listener);
  },
  ref() {
    process.channel!.ref();
  },
  unref() {
    process.channel!.unref();
  },
};
const { context, initialize } = createContext(port);
await initialize();
Object.defineProperty(globalThis, "ipab", { value: context, writable: false });
process.argv = [process.execPath, entry, ...process.argv.slice(3)];
createRequire(import.meta.url)(entry);
