import { runBundleViewer } from "@ipab/bundle-viewer";
import schema from "../../schemas/content.json" with { type: "json" };
import { viewer } from "../shared/viewer.js";

declare const ipab: Parameters<typeof runBundleViewer>[0]["context"];

void (async () => {
  const args = process.argv.slice(2).filter((value) => value !== "--no-open");
  const folder =
    args.length === 2 && args[0] === "--folder" ? args[1] : undefined;
  if (!folder && (args.length !== 1 || args[0] === "--folder"))
    throw new Error("Expected one folder, pin or CID, or --folder PATH");
  await runBundleViewer({
    context: ipab,
    ...(folder ? { folder } : { source: args[0]! }),
    schema,
    viewer,
    frontendRoot: "resources/web",
  });
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
