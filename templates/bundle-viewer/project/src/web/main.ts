import { hydrateBundleViewer } from "@ipab/bundle-viewer/browser";
import { viewer } from "../shared/viewer.js";
import "./style.css";

void hydrateBundleViewer(viewer).catch((error: unknown) => {
  console.error(error);
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent =
    error instanceof Error ? error.message : "Viewer startup failed";
  document.body.append(alert);
});
