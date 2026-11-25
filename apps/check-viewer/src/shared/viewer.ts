import { createElement } from "react";
import { CheckBundleViewer } from "@ipab/check-spec";
import type { BundleViewer } from "@ipab/bundle-viewer/browser";

export const viewer: BundleViewer = ({ data }) =>
  createElement(
    "div",
    { className: "cbv-fill" },
    createElement(CheckBundleViewer, { spec: data }),
  );
