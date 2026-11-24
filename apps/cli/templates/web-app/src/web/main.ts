import { connectWebApp } from "@ipab/web-app/browser";
import { parseGreetingReply } from "../shared/protocol.js";
import "./style.css";

const form = document.querySelector<HTMLFormElement>("#greeting")!;
const name = document.querySelector<HTMLInputElement>("#name")!;
const button = document.querySelector<HTMLButtonElement>("button")!;
const reply = document.querySelector<HTMLElement>("#reply")!;
const events = document.querySelector<HTMLElement>("#events")!;

void (async () => {
  const app = await connectWebApp();
  reply.textContent = "Connected. Send a greeting to your backend.";
  button.disabled = false;
  let received = 0;
  app.onEvent((event) => {
    if (event.name === "greeting") {
      received += 1;
      events.textContent = `Backend events received: ${received}`;
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    button.disabled = true;
    void app
      .request("greet", { name: name.value })
      .then((value) => {
        reply.textContent = parseGreetingReply(value).message;
      })
      .catch((error: unknown) => {
        reply.textContent =
          error instanceof Error ? error.message : "The greeting failed.";
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  window.addEventListener(
    "pagehide",
    () => {
      app.close();
    },
    { once: true },
  );
})().catch((error: unknown) => {
  reply.textContent =
    error instanceof Error ? error.message : "Could not connect to the App.";
});
