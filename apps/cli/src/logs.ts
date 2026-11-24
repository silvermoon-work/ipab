import {
  lstat,
  mkdir,
  open,
  unlink,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { HostError } from "./errors.js";

async function directory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new HostError("Invalid execution log directory.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function location(stateDirectory: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new HostError("Invalid execution log identity.");
  return join(stateDirectory, "logs", id);
}

export async function logFiles(
  stateDirectory: string,
  id: string,
): Promise<{ stdout: string | null; stderr: string | null }> {
  const result: { stdout: string | null; stderr: string | null } = {
    stdout: null,
    stderr: null,
  };
  if (!(await directory(join(stateDirectory, "logs")))) return result;
  const path = location(stateDirectory, id);
  if (!(await directory(path))) return result;
  for (const stream of ["stdout", "stderr"] as const) {
    const file = join(path, `${stream}.log`);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new HostError("Invalid execution log file.");
      result[stream] = file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

export async function removeLogs(
  stateDirectory: string,
  id: string,
): Promise<void> {
  const files = await logFiles(stateDirectory, id);
  for (const file of Object.values(files)) {
    if (file) {
      try {
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  if (!(await directory(join(stateDirectory, "logs")))) return;
  const path = location(stateDirectory, id);
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class ExecutionLogs {
  private constructor(
    private readonly stdout: FileHandle,
    private readonly stderr: FileHandle,
  ) {}

  static async create(
    stateDirectory: string,
    id: string,
  ): Promise<ExecutionLogs> {
    const parent = join(stateDirectory, "logs");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await directory(parent);
    const path = location(stateDirectory, id);
    await mkdir(path, { mode: 0o700 });
    const stdout = await open(join(path, "stdout.log"), "wx", 0o600);
    try {
      return new ExecutionLogs(
        stdout,
        await open(join(path, "stderr.log"), "wx", 0o600),
      );
    } catch (error) {
      await stdout.close();
      throw error;
    }
  }

  async forward(
    source: Readable,
    destination: Writable,
    stream: "stdout" | "stderr",
  ): Promise<void> {
    for await (const chunk of source) {
      if (!Buffer.isBuffer(chunk))
        throw new HostError("Invalid execution output bytes.");
      await this[stream].writeFile(chunk);
      await new Promise<void>((resolve, reject) => {
        destination.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.stdout.close(),
      this.stderr.close(),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
