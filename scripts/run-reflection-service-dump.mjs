#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createStudioOAuthTokens,
  exchangeAuthenticationTicket,
  mask,
  runProcess,
  validateCookie,
} from "./roblox-auth.mjs";

const marker = "__REFLECTION_SERVICE_DUMP__";
const versionMarker = `${marker}VERSION:`;
const chunkMarker = `${marker}CHUNK:`;
const registryPath = "HKCU:\\Software\\Roblox\\RobloxStudioBrowser\\roblox.com";
const credentialPrefix = "https://www.roblox.com:RobloxStudioAuth";
const credentialScript = `
using System;
using System.Runtime.InteropServices;
public static class StudioCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Credential {
    public uint Flags, Type; public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize; public IntPtr Blob; public uint Persist, AttributeCount;
    public IntPtr Attributes; public string TargetAlias, UserName;
  }
  [DllImport("advapi32", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WriteNative(ref Credential credential, uint flags);
  [DllImport("advapi32", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool DeleteNative(string target, uint type, uint flags);
  public static void Write(string target, byte[] value, string userName) { var handle=GCHandle.Alloc(value,GCHandleType.Pinned); try { var c=new Credential { Type=1, TargetName=target, BlobSize=(uint)value.Length, Blob=handle.AddrOfPinnedObject(), Persist=2, UserName=userName }; if(!WriteNative(ref c,0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } finally { handle.Free(); } }
  public static void Delete(string target) { if(!DeleteNative(target,1,0) && Marshal.GetLastWin32Error()!=1168) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
}`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  for (const required of ["studio", "version", "script", "result"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

async function powershell(command, env = {}) {
  return runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, CREDENTIAL_SCRIPT: credentialScript, ...env },
  });
}

async function writeCredential(target, value, userName = "") {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  await powershell(`Add-Type $env:CREDENTIAL_SCRIPT; [StudioCredential]::Write($env:TARGET,[Convert]::FromBase64String($env:VALUE),$env:USERNAME)`, { TARGET: target, VALUE: bytes.toString("base64"), USERNAME: userName });
}

async function deleteCredential(target) {
  await powershell(`Add-Type $env:CREDENTIAL_SCRIPT; [StudioCredential]::Delete($env:TARGET)`, { TARGET: target });
}

async function installCredentials(cookie, userId, tokens) {
  const credentials = new Map([
    [`${credentialPrefix}Cookies`, [".ROBLOSECURITY;", "RobloxStudio"]],
    [`${credentialPrefix}.ROBLOSECURITY${userId}`, [cookie]],
    [`${credentialPrefix}userid`, [String(userId)]],
    [`${credentialPrefix}hasMigratedToMultiUser2`, ["true"]],
    [`${credentialPrefix}accessToken${userId}`, [tokens.accessToken]],
    [`${credentialPrefix}oauth2RefreshToken${userId}`, [tokens.refreshToken]],
    [`${credentialPrefix}expiresAtSecSinceEpoch${userId}`, [tokens.expiresAt]],
  ]);
  try {
    for (const [target, [value, userName]] of credentials) {
      await writeCredential(target, value, userName);
    }
    return [...credentials.keys()];
  } catch (error) {
    await removeCredentials(credentials.keys());
    throw error;
  }
}

async function removeCredentials(targets) {
  for (const target of targets) await deleteCredential(target);
}

async function setRegistryCookie(cookie) {
  await powershell(`$p='${registryPath}'; New-Item -Path $p -Force | Out-Null; $v='SEC::<YES>,EXP::<9999-01-01T00:00:00Z>,COOK::<'+$env:COOKIE+'>'; New-ItemProperty -Path $p -Name '.ROBLOSECURITY' -Value $v -PropertyType String -Force | Out-Null`, { COOKIE: cookie });
}

async function removeRegistryCookie() {
  await powershell(`Remove-ItemProperty -Path '${registryPath}' -Name '.ROBLOSECURITY' -ErrorAction SilentlyContinue`);
}

function launchStudio(executable, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ROBLOSECURITY;
    delete env.GH_TOKEN;
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true, env });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("exit", () => finish(new Error(`Studio timed out after ${timeout} ms`)));
      killer.once("error", () => finish(new Error(`Studio timed out after ${timeout} ms`)));
    }, timeout);
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(code === 0 ? undefined : new Error(`Studio exited with ${code ?? signal}`)));
  });
}

function updateDump(target, dump) {
  return readFile(target, "utf8").then((old) => JSON.stringify(JSON.parse(old)) === JSON.stringify(dump)).catch(() => false);
}

try {
  if (!process.env.GITHUB_ACTIONS) throw new Error("ReflectionService Studio execution is only enabled in GitHub Actions");
  if (process.platform !== "win32") throw new Error("Roblox Studio execution requires Windows");
  const options = parseArgs(process.argv.slice(2));
  const studio = path.resolve(options.studio);
  const sourceCookie = process.env.ROBLOSECURITY?.trim();
  if (!sourceCookie) throw new Error("ROBLOSECURITY is missing");
  if (!existsSync(studio)) throw new Error(`Studio not found: ${studio}`);

  const user = await validateCookie(sourceCookie);
  console.log(`Authenticated source cookie for ${user.name} (${user.id})`);
  const cookie = await exchangeAuthenticationTicket(sourceCookie);
  mask(cookie);
  const tokens = await createStudioOAuthTokens(cookie);
  mask(tokens.accessToken); mask(tokens.refreshToken);

  const workDir = path.resolve(".studio-run");
  const wrapper = path.join(workDir, "reflection-runner.luau");
  const log = path.join(workDir, "studio-output.log");
  await mkdir(workDir, { recursive: true });
  const source = await readFile(path.resolve(options.script), "utf8");
  await writeFile(wrapper, `local engineVersion, dump = (function()\n${source}\nend)()\nprint("${versionMarker}" .. tostring(engineVersion))\nlocal chunkSize = 20000\nlocal chunkCount = math.ceil(#dump / chunkSize)\nfor index = 1, chunkCount do\n\tlocal first = (index - 1) * chunkSize + 1\n\tprint("${chunkMarker}" .. index .. ":" .. chunkCount .. ":" .. string.sub(dump, first, first + chunkSize - 1))\nend\n`);
  await rm(log, { force: true });

  const credentialTargets = await installCredentials(cookie, user.id, tokens);
  try {
    await setRegistryCookie(cookie);
    await launchStudio(studio, ["--task", "RunScript", "--runScriptFile", wrapper, "--outputFile", log, "--quitAfterExecution"]);
  } finally {
    try { await removeRegistryCookie(); }
    finally { await removeCredentials(credentialTargets); }
  }

  const output = await readFile(log, "utf8");
  const lines = output.split(/\r?\n/);
  const versionLine = lines.find((value) => value.startsWith(versionMarker));
  if (!versionLine) throw new Error(`Studio returned no marked version. Output:\n${output}`);
  const engineVersion = versionLine.slice(versionMarker.length);
  if (!/^[A-Za-z0-9._-]+$/.test(engineVersion)) throw new Error(`Unusable engine version: ${engineVersion}`);
  const chunks = new Map();
  let chunkCount = 0;
  for (const line of lines) {
    if (!line.startsWith(chunkMarker)) continue;
    const match = line.slice(chunkMarker.length).match(/^(\d+):(\d+):(.*)$/);
    if (!match) throw new Error("Studio returned a malformed ReflectionService chunk");
    chunks.set(Number(match[1]), match[3]);
    chunkCount = Number(match[2]);
  }
  if (!chunkCount || chunks.size !== chunkCount) {
    throw new Error(`Studio returned ${chunks.size} of ${chunkCount || "?"} ReflectionService chunks`);
  }
  const dump = JSON.parse(Array.from({ length: chunkCount }, (_, index) => chunks.get(index + 1)).join(""));
  const targets = [
    path.resolve("reflectionservice-dumps", "engine", `${engineVersion}-ReflectionService-Dump.json`),
    path.resolve("reflectionservice-dumps", "hashes", `version-${options.version.replace(/^version-/, "")}-ReflectionService-Dump.json`),
  ];
  const outputs = [];
  for (const target of targets) {
    if (await updateDump(target, dump)) { console.log(`${target} unchanged`); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(dump, null, 2)}\n`);
    outputs.push(path.relative(process.cwd(), target).replaceAll("\\", "/"));
    console.log(`Wrote ${target}`);
  }
  await writeFile(path.resolve(options.result), `${JSON.stringify({ status: outputs.length ? "written" : "unchanged", engine_version: engineVersion, outputs }, null, 2)}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
