export type GreetingRequest = { name: string };
export type GreetingReply = { message: string };

export function parseGreetingRequest(value: unknown): GreetingRequest {
  if (
    !value ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 80 ||
    Object.keys(value).some((key) => key !== "name")
  )
    throw new Error("Enter a name of 1 to 80 characters.");
  return { name: value.name.trim() };
}

export function parseGreetingReply(value: unknown): GreetingReply {
  if (
    !value ||
    typeof value !== "object" ||
    !("message" in value) ||
    typeof value.message !== "string" ||
    Object.keys(value).some((key) => key !== "message")
  )
    throw new Error("The backend returned an invalid greeting.");
  return { message: value.message };
}
