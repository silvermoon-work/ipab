import { runBundleViewer } from "@ipab/bundle-viewer";
import schema from "../../schemas/content.json" with { type: "json" };
import { viewer } from "../shared/viewer.js";

declare const ipab: Parameters<typeof runBundleViewer>[0]["context"];

void (async () => {
  const args = process.argv.slice(2).filter((value) => value !== "--no-open");
  if (args.length !== 1) throw new Error("Expected one Content Bundle CID");
  await runBundleViewer({
    context: ipab,
    contentCid: args[0]!,
    schema,
    viewer,
    frontendRoot: "resources/web",
  });
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
