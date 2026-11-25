import { createElement, useState } from "react";
import type { BundleViewer } from "@ipab/bundle-viewer/browser";

export const viewer: BundleViewer = ({ data }) => {
  const [expanded, setExpanded] = useState(false);
  if (
    !data ||
    typeof data !== "object" ||
    !("message" in data) ||
    typeof data.message !== "string"
  )
    throw new Error("Expected a message Content Bundle");
  return createElement(
    "main",
    null,
    createElement("h1", null, data.message),
    createElement(
      "button",
      {
        onClick: () => {
          setExpanded(!expanded);
        },
      },
      expanded ? "Less" : "More",
    ),
    expanded
      ? createElement(
          "p",
          null,
          "Rendered on the server, interactive in your browser.",
        )
      : null,
  );
};
