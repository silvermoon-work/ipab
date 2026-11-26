// @vitest-environment jsdom
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckBundleViewer } from "../src/viewer.js";
import { orderedSpec } from "./fixtures.js";
import { browser } from "./browser.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
describe("Check content SSR", { tags: ["unit"] }, () => {
  it.each([false, true])(
    "hydrates identical SSR nodes before adapting to mobile=%s",
    async (mobile) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const platform = browser(mobile);
      const spec = orderedSpec();
      const element = <CheckBundleViewer spec={spec} />;
      const host = document.createElement("div");
      host.innerHTML = renderToString(element);
      document.body.append(host);
      const heading = host.querySelector("h2");
      const failures: unknown[] = [];
      let root!: ReturnType<typeof hydrateRoot>;
      await act(async () => {
        root = hydrateRoot(host, element, {
          onRecoverableError(error) {
            failures.push(error);
          },
        });
        await Promise.resolve();
      });
      expect(failures).toEqual([]);
      expect(host.querySelector("h2")).toBe(heading);
      if (mobile) {
        await act(async () => {
          host
            .querySelector<HTMLButtonElement>(".cbv-navigation-toggle")!
            .click();
          await Promise.resolve();
        });
      }
      const button = [...host.querySelectorAll("button")].find(
        (item) => item.title === spec.checkpoints[0]!.title,
      )!;
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      platform.flush();
      expect(host.querySelector(".cbv-details strong")!.textContent).toBe(
        "目录",
      );
      expect(host.querySelector(".cbv-details")!.textContent).toContain(
        "逐项核对上下文",
      );
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    },
  );
});
