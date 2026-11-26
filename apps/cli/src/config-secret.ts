import { chmodSync, existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HostError, syntax } from "./errors.js";

export async function readSecretStream(
  input: AsyncIterable<string>,
): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    if (Buffer.byteLength(text) + Buffer.byteLength(chunk) > 64)
      syntax("API key input exceeds 64 bytes.");
    text += chunk;
  }
  return text.trim();
}

function windowsAcl(paths: string[], protect: boolean): void {
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($path in (ConvertFrom-Json $env:IPAB_CONFIG_PATHS)) {
$acl = Get-Acl -LiteralPath $path
if ($env:IPAB_CONFIG_PROTECT -eq 'true') {
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
} else {
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) {
      throw 'Configuration storage must be account-only'
    }
  }
}
}`;
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key.toLowerCase() !== "psmodulepath",
          ),
        ),
        IPAB_CONFIG_PATHS: JSON.stringify(paths),
        IPAB_CONFIG_PROTECT: String(protect),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
export function secureConfigurationStorage(
  directory: string,
  protect: boolean,
): void {
  try {
    const paths = [
      directory,
      ...["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"].map((file) =>
        join(directory, file),
      ),
    ].filter((path) => existsSync(path));
    for (const path of paths) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error();
      if (process.platform !== "win32") {
        if (stat.uid !== process.getuid?.()) throw new Error();
        if (protect) chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
        else if ((stat.mode & 0o077) !== 0) throw new Error();
      }
    }
    if (process.platform === "win32") windowsAcl(paths, protect);
  } catch {
    throw new HostError(
      "Pointer API key configuration requires account-only state storage permissions.",
    );
  }
}
