import { main } from "./main.js";

void main("deploy").catch((error: unknown) => {
  console.error(error);
  process.exitCode ??= 1;
});
