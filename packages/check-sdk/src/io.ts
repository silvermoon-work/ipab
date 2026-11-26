import { parseData } from "@ipab/bundle/data";
import type { ContentType } from "@ipab/bundle";

export async function readJson(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  contentType: ContentType = "application/json",
): Promise<unknown> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  await stream.pipeTo(
    new WritableStream<Uint8Array>({
      write(part) {
        bytes += part.byteLength;
        if (bytes > 1024 * 1024) throw new Error("Check JSON exceeds 1 MiB.");
        parts.push(part);
      },
    }),
    { signal },
  );
  return parseData(Buffer.concat(parts), contentType);
}
export function jsonStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
