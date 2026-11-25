const text = { type: "string", minLength: 1, pattern: "\\S" };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });

export const checkBundleSpecSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...object(
    {
      $schema: { const: "urn:ipfsaw:check-bundle:1" },
      specVersion: { const: "1.0" },
      name: text,
      description: text,
      parameter: object({
        schema: {
          type: "object",
          required: ["type"],
          properties: { type: { const: "object" } },
        },
      }),
      checkpoints: {
        type: "array",
        minItems: 1,
        items: object({
          id: {
            type: "string",
            pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$",
            not: { pattern: "^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\\.|$)" },
          },
          title: text,
          description: text,
          instructions: text,
          output: object(
            {
              description: text,
              fields: {
                type: "array",
                minItems: 1,
                items: object({ name: text, description: text }),
              },
            },
            ["description"],
          ),
          rules: {
            type: "array",
            minItems: 1,
            items: object({ code: text, description: text }),
          },
        }),
      },
    },
    ["specVersion", "name", "description", "parameter", "checkpoints"],
  ),
} as const;
