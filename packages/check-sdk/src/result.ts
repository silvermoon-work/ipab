import type { BundleType } from "@ipab/bundle";

const body = {
  check: { const: "check" },
  checkpoint: { type: "string" },
};
export const resultDefinition: BundleType = {
  contentType: "application/json",
  schema: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["check", "checkpoint", "pass"],
        properties: { ...body, pass: { const: true } },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["check", "checkpoint", "pass", "problems"],
        properties: {
          ...body,
          pass: { const: false },
          problems: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "context"],
              properties: { code: { type: "string" }, context: true },
            },
          },
        },
      },
    ],
  },
};
