#!/usr/bin/env node
/**
 * fetch-full-dump.mjs
 *
 * 1. Downloads Roblox Studio via roblox-rdd-downloader
 * 2. Generates normal API dump (-api)
 * 3. Patches Studio and generates full API dump (--fullapi)
 * 4. Merges both dumps (full as base, normal fills missing tags/members)
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { download } from "roblox-rdd-downloader";

const STUDIO_DIR = "./RobloxStudio";
const PATCHER_URL =
  "https://github.com/setup-rbxcdn/fullapidump-studio-patcher/releases/latest/download/fullapidump-studio-patcher-windows.exe";
const PATCHER_EXE = "fullapidump-studio-patcher-windows.exe";

// --- Merge Logic (ported from merge_jsons.py) ---

function tagKey(tag) {
  if (typeof tag === "string") return tag;
  if (tag && typeof tag === "object") {
    return JSON.stringify(
      Object.entries(tag).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return String(tag);
}

function mergeTags(fullTags, normalTags) {
  const existing = new Set(fullTags.map(tagKey));
  for (const tag of normalTags) {
    const k = tagKey(tag);
    if (!existing.has(k)) {
      fullTags.push(structuredClone(tag));
      existing.add(k);
    }
  }
}

function sync(fullObj, normalObj) {
  if (
    fullObj &&
    normalObj &&
    typeof fullObj === "object" &&
    typeof normalObj === "object"
  ) {
    if (Array.isArray(fullObj) && Array.isArray(normalObj)) {
      const isNamed = normalObj.length > 0 && normalObj[0]?.Name !== undefined;
      if (isNamed) {
        const byName = new Map();
        for (const item of fullObj) {
          if (item?.Name !== undefined) byName.set(item.Name, item);
        }
        for (const nItem of normalObj) {
          const name = nItem?.Name;
          if (name !== undefined && byName.has(name)) {
            sync(byName.get(name), nItem);
          } else {
            fullObj.push(structuredClone(nItem));
          }
        }
      } else {
        for (let i = 0; i < Math.min(fullObj.length, normalObj.length); i++) {
          sync(fullObj[i], normalObj[i]);
        }
      }
    } else if (!Array.isArray(fullObj) && !Array.isArray(normalObj)) {
      for (const key of Object.keys(normalObj)) {
        if (key === "Tags") {
          if (Array.isArray(fullObj.Tags)) {
            mergeTags(fullObj.Tags, normalObj.Tags);
          } else {
            fullObj.Tags = structuredClone(normalObj.Tags);
          }
        } else if (!(key in fullObj)) {
          fullObj[key] = structuredClone(normalObj[key]);
        } else {
          sync(fullObj[key], normalObj[key]);
        }
      }
    }
  }
}

function formatEmptyArrays(jsonStr) {
  const fields = ["Members", "Parameters", "Items"];
  for (const field of fields) {
    // Match: [indent]"Field": []
    // Replace with: [indent]"Field": [\n[indent]]
    const regex = new RegExp(`^(\\s*)"${field}": \\[\\]`, "gm");
    jsonStr = jsonStr.replace(regex, (match, indent) => {
      return `${indent}"${field}": [\n${indent}]`;
    });
  }
  return jsonStr;
}

async function mergeDumps(normalPath, fullPath, outputPath) {
  const normal = JSON.parse(await readFile(normalPath, "utf-8"));
  const full = JSON.parse(await readFile(fullPath, "utf-8"));

  sync(full, normal);

  let jsonStr = JSON.stringify(full, null, 4);
  jsonStr = formatEmptyArrays(jsonStr);

  await writeFile(outputPath, jsonStr + "\n", "utf-8");
  console.log(`Merged dump written to ${outputPath}`);
}

// --- Helpers ---

async function downloadFile(url, destPath) {
  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  console.log(`  Saved to ${destPath}`);
}

function runCommand(cmd, args, cwd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${cmd} ${args.join(" ")}`);
    const proc = execFile(
      cmd,
      args,
      { cwd, shell: true, timeout },
      (err, stdout, stderr) => {
        if (err && err.code !== "TIMEOUT") reject(err);
        else resolve({ stdout, stderr });
      },
    );
    proc.stdout?.on("data", (d) => process.stdout.write(d));
    proc.stderr?.on("data", (d) => process.stderr.write(d));
  });
}

async function downloadStudioWithFallback(version, outDir) {
  const channels = ["LIVE", "zbeta"];
  let lastErr = null;

  for (const channel of channels) {
    try {
      console.log(
        `Attempting download on channel "${channel}" (${version})...`,
      );
      await download({
        binaryType: "WindowsStudio64",
        version,
        out: outDir,
        channel,
      });
      console.log(`  Success on channel "${channel}"`);
      return channel;
    } catch (err) {
      console.log(`  Failed on channel "${channel}": ${err.message}`);
      lastErr = err;
    }
  }

  throw new Error(
    `Download failed on all channels (${channels.join(", ")}): ${lastErr?.message}`,
  );
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      version = args[++i];
      break;
    }
    if (args[i].startsWith("--version=")) {
      version = args[i].split("=")[1];
      break;
    }
  }
  if (!version) {
    console.error("Error: --version <hash> is required.");
    console.error("Usage: node fetch-full-dump.mjs --version <commit-hash>");
    process.exit(1);
  }

  const outDir = path.resolve(STUDIO_DIR);
  await mkdir(outDir, { recursive: true });

  // Step 1: Download Studio
  console.log(`\n=== Step 1: Downloading Roblox Studio (${version}) ===`);
  const usedChannel = await downloadStudioWithFallback(version, outDir);

  const studioExe = path.join(outDir, "RobloxStudioBeta.exe");
  if (!existsSync(studioExe))
    throw new Error(`RobloxStudioBeta.exe not found at ${studioExe}`);
  console.log(`Studio ready: ${studioExe}`);

  // Step 2: Generate NORMAL API dump
  console.log("\n=== Step 2: Generating Normal API Dump ===");
  const normalJson = path.join(outDir, "Normal-API-Dump.json");
  if (existsSync(normalJson)) await unlink(normalJson);

  try {
    await runCommand(
      studioExe,
      ["-api", "Normal-API-Dump.json"],
      outDir,
      60000,
    );
  } catch (err) {
    console.log(`  (Process exited: ${err.message})`);
  }
  if (!existsSync(normalJson))
    throw new Error(`Normal API dump not created at ${normalJson}`);
  console.log(`Normal dump: ${normalJson}`);

  // Step 3: Download & run patcher
  console.log("\n=== Step 3: Patching Studio ===");
  const patcherPath = path.join(outDir, PATCHER_EXE);
  if (!existsSync(patcherPath)) await downloadFile(PATCHER_URL, patcherPath);
  else console.log(`  Patcher exists: ${patcherPath}`);

  const patchedExe = path.join(outDir, "RobloxStudioBeta_FULLDUMP.exe");
  await runCommand(patcherPath, [`"${studioExe}"`], outDir);
  if (!existsSync(patchedExe))
    throw new Error(`Patched exe not created at ${patchedExe}`);
  console.log(`Patched: ${patchedExe}`);

  // Step 4: Generate FULL API dump
  console.log("\n=== Step 4: Generating Full API Dump ===");
  const fullJson = path.join(outDir, "Full-API-Dump.json");
  if (existsSync(fullJson)) await unlink(fullJson);

  try {
    await runCommand(
      patchedExe,
      ["--fullapi", "Full-API-Dump.json"],
      outDir,
      60000,
    );
  } catch (err) {
    console.log(`  (Process exited: ${err.message})`);
  }
  if (!existsSync(fullJson))
    throw new Error(`Full API dump not created at ${fullJson}`);
  console.log(`Full dump: ${fullJson}`);

  // Step 5: Merge dumps
  console.log("\n=== Step 5: Merging Dumps ===");
  const mergedJson = path.join(outDir, "Merged-API-Dump.json");
  await mergeDumps(normalJson, fullJson, mergedJson);

  // Print summary
  const merged = JSON.parse(await readFile(mergedJson, "utf-8"));
  console.log(`  Classes: ${Object.keys(merged.Classes || {}).length}`);
  console.log(`  Enums: ${Object.keys(merged.Enums || {}).length}`);
  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
