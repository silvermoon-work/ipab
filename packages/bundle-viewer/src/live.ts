import { createElement, type ReactNode } from "react";
import type { BundleViewer } from "./viewer.js";

export interface LiveView {
  data: unknown;
  error: string;
}
export function liveView(viewer: BundleViewer, state: LiveView): ReactNode {
  return createElement(
    "div",
    { style: { height: "100%" } },
    createElement("p", { role: "alert", hidden: !state.error }, state.error),
    createElement(
      "div",
      { hidden: Boolean(state.error), style: { height: "100%" } },
      state.data === undefined
        ? null
        : createElement(viewer, { data: state.data }),
    ),
  );
}
