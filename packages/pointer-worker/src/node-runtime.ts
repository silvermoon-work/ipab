export interface NodeRuntime {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number;
  platform: string;
  getuid?: () => number;
}
export const runtime = globalThis as unknown as { process: NodeRuntime };
