import { main } from "./main.js";

void main("local").catch((error: unknown) => {
  console.error(error);
  process.exitCode ??= 1;
});
