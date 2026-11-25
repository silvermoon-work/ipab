const text = { type: "string" };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, required, properties });

export const checkSpecDefinition = {
  name: "IPAB Check Spec",
  description:
    "Ordered Check definition with optional Bundle-local Markdown instructions.",
  entry: {
    path: "check.yaml",
    contentType: "application/yaml" as const,
    schema: object(
      {
        $schema: { enum: ["urn:ipfsaw:check-bundle:1"] },
        specVersion: { enum: ["1.0"] },
        name: text,
        description: text,
        parameter: object({ schema: { type: "object" } }),
        checkpoints: {
          type: "array",
          items: object({
            id: text,
            title: text,
            description: text,
            instructions: {
              anyOf: [text, object({ path: text })],
            },
            output: object(
              {
                description: text,
                fields: {
                  type: "array",
                  items: object({ name: text, description: text }),
                },
              },
              ["description"],
            ),
            rules: {
              type: "array",
              items: object({ code: text, description: text }),
            },
          }),
        },
      },
      ["specVersion", "name", "description", "parameter", "checkpoints"],
    ),
    defaultValue: {
      specVersion: "1.0",
      name: "Untitled Check",
      description: "Describe the scope of the check.",
      parameter: { schema: { type: "object" } },
      checkpoints: [
        {
          id: "review",
          title: "Review",
          description: "Review the supplied target.",
          instructions: "Read the target and report evidence.",
          output: { description: "Successful output is undefined." },
          rules: [
            {
              code: "target-valid",
              description: "The target meets the documented requirements.",
            },
          ],
        },
      ],
    },
  },
};
