import type { BundleManifest } from "@ipab/bundle";

const body = {
  check: { const: "check" },
  checkpoint: { type: "string" },
};
export const resultDefinition: BundleManifest = {
  name: "IPAB Check Result",
  description: "Check outcome with the original Check model linked at check/.",
  entry: {
    path: "result.json",
    contentType: "application/json",
    defaultValue: { check: "check", checkpoint: "review", pass: true },
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
  },
};
