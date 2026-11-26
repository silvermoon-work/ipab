import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { runtime } from "./node-runtime.js";

const execute = promisify(execFile);
// Paths are passed through the environment, never interpolated into shell code.
const ACL_CHECK = `
$ErrorActionPreference = 'Stop'
$path = $env:IPAB_SECRET_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $path
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid) {
    throw 'File must be accessible only by the current OS account'
  }
}
`;
const ACL_PROTECT = `
$ErrorActionPreference = 'Stop'
$path = $env:IPAB_SECRET_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ((Get-Item -LiteralPath $path).PSIsContainer) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
}
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
if ((Get-Item -LiteralPath $path).PSIsContainer) {
  [System.IO.Directory]::SetAccessControl($path, $acl)
} else {
  [System.IO.File]::SetAccessControl($path, $acl)
}
`;
export interface FileAccessIO {
  platform: string;
  uid: number | undefined;
  inspect: (path: string) => Promise<{
    mode: number;
    uid: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  acl: (path: string, protect: boolean) => Promise<void>;
  aclMany?: (paths: string[]) => Promise<void>;
}
const accessIO = (): FileAccessIO => ({
  platform: runtime.process.platform,
  uid: runtime.process.getuid?.(),
  inspect: lstat,
  aclMany: async (paths) => {
    const source = `foreach ($path in (ConvertFrom-Json $env:IPAB_SECRET_PATHS)) {\n${ACL_CHECK.replace("$path = $env:IPAB_SECRET_PATH", "")}\n}`;
    const script = btoa(
      source
        .split("")
        .map((char) => char + "\0")
        .join(""),
    );
    await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", script],
      {
        env: {
          ...Object.fromEntries(
            Object.entries(runtime.process.env).filter(
              ([key]) => key.toLowerCase() !== "psmodulepath",
            ),
          ),
          IPAB_SECRET_PATHS: JSON.stringify(paths),
        },
      },
    );
  },
  acl: async (path, protect) => {
    const script = btoa(
      (protect ? ACL_PROTECT : ACL_CHECK)
        .split("")
        .map((char) => char + "\0")
        .join(""),
    );
    await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", script],
      {
        env: {
          ...Object.fromEntries(
            Object.entries(runtime.process.env).filter(
              ([key]) => key.toLowerCase() !== "psmodulepath",
            ),
          ),
          IPAB_SECRET_PATH: path,
        },
      },
    );
  },
});
export async function requireAccountOnly(
  path: string,
  io = accessIO(),
): Promise<void> {
  const info = await io.inspect(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
    throw new Error("secret path must be a regular file or directory");
  if (io.platform === "win32") await io.acl(path, false);
  else if ((info.mode & 0o077) !== 0 || info.uid !== io.uid)
    throw new Error(
      "secret path must be accessible only by the current OS account (chmod 600 file / 700 directory)",
    );
}
export async function readProtected(path: string): Promise<string> {
  await requireAccountOnly(path);
  return readFile(path, "utf8");
}
export async function requireAccountOnlyMany(
  paths: string[],
  io = accessIO(),
): Promise<void> {
  for (const path of paths) {
    const info = await io.inspect(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new Error("secret path must be a regular file or directory");
    if (
      io.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== io.uid)
    )
      throw new Error(
        "secret path must be accessible only by the current OS account",
      );
  }
  if (io.platform === "win32") {
    if (io.aclMany) await io.aclMany(paths);
    else for (const path of paths) await io.acl(path, false);
  }
}
export async function protectAccountOnly(
  path: string,
  io = accessIO(),
): Promise<void> {
  const info = await io.inspect(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
    throw new Error("secret path must be a regular file or directory");
  if (io.platform === "win32") {
    await io.acl(path, true);
    return;
  } else {
    if (info.uid !== io.uid)
      throw new Error("secret path must belong to the current account");
    await chmod(path, info.isDirectory() ? 0o700 : 0o600);
  }
  await requireAccountOnly(path, io);
}
export async function saveProtected(path: string, text: string): Promise<void> {
  const dir = dirname(path),
    created = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (created && runtime.process.platform === "win32")
    await accessIO().acl(dir, true);
  await requireAccountOnly(dir);
  await writeFile(path, text, { mode: 0o600, flag: "wx" });
  if (runtime.process.platform === "win32") await accessIO().acl(path, true);
}
