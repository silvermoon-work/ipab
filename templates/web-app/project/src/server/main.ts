import { defineWebAppMethod, runWebApp } from "@ipab/web-app";
import {
  parseGreetingReply,
  parseGreetingRequest,
} from "../shared/protocol.js";

declare const ipab: Parameters<typeof runWebApp>[0]["context"];

void runWebApp({
  context: ipab,
  frontendRoot: "resources/web",
  handlers: {
    greet: defineWebAppMethod({
      request: { parse: parseGreetingRequest },
      response: { parse: parseGreetingReply },
      handle(input, context) {
        context.signal.throwIfAborted();
        context.emit("greeting", { name: input.name });
        return { message: `Hello, ${input.name}. Your App is listening.` };
      },
    }),
  },
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
