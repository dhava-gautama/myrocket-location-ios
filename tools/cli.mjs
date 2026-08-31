#!/usr/bin/env node
/**
 * MyRocket Location Spoofer CLI.
 *
 *   node tools/cli.mjs build <app> [lat] [lng] [hacc]   # render module files
 *   node tools/cli.mjs build all [lat] [lng] [hacc]
 *   node tools/cli.mjs test                            # run unit tests
 *   node tools/cli.mjs demo [lat] [lng]                # end-to-end fixture run
 *   node tools/cli.mjs dump <hexfile> [lat] [lng]      # patch a hex dump
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseArgumentString,
  resolveConfigUrl,
  spoofWlocResponse,
} from "../core/wloc.mjs";
import { runTests } from "../test/wloc.test.mjs";
import { hexToBytes, bytesToHex } from "../test/hex.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const MODULES = join(ROOT, "modules");

const APPS = ["shadowrocket", "surge", "loon", "quantumultx", "stash"];

async function renderTemplate(app, config) {
  const template = await readFile(join(MODULES, app + ".template"), "utf8");
  const out = template
    .replace(/\{\{LATITUDE\}\}/g, String(config.latitude))
    .replace(/\{\{LONGITUDE\}\}/g, String(config.longitude))
    .replace(/\{\{HACC\}\}/g, String(config.horizontalAccuracy));
  const target = app === "quantumultx" ? "myrocket-location-ios.snippet"
    : app === "stash" ? "myrocket-location-ios.stoverride"
    : app === "surge" ? "myrocket-location-ios-surge.sgmodule"
    : app === "loon" ? "myrocket-location-ios.lnplugin"
    : "myrocket-location-ios.sgmodule";
  const path = join(DIST, target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, out);
  return path;
}

async function cmdBuild(args) {
  const app = args[0] || "all";
  const config = normalizeConfig({
    latitude: args[1],
    longitude: args[2],
    horizontalAccuracy: args[3],
  });
  const targets = app === "all" ? APPS : [app];
  if (targets.some((t) => !APPS.includes(t))) {
    throw new Error("unknown target " + app + " (known: " + APPS.join(", ") + ")");
  }
  const written = [];
  for (const target of targets) written.push(await renderTemplate(target, config));
  // dist/wloc.engine.js is produced by tools/build-dist.mjs (engine + adapter,
  // exports stripped). Rebuild it here so dist is always self-consistent.
  const { buildDist } = await import("./build-dist.mjs");
  written.push(await buildDist());
  console.log("configured: lat=%s lng=%s hacc=%s", config.latitude, config.longitude, config.horizontalAccuracy);
  for (const path of written) console.log("wrote " + path);
}

async function cmdTest() {
  const ok = runTests();
  if (!ok) process.exitCode = 1;
}

async function cmdDemo(args) {
  const config = normalizeConfig({
    latitude: args[0],
    longitude: args[1],
    horizontalAccuracy: args[2],
  });
  const fixtureHex = await readFile(join(ROOT, "test", "fixtures", "arpc-response.hex"), "utf8");
  const body = hexToBytes(fixtureHex.replace(/\s+/g, ""));
  const result = spoofWlocResponse(body, config);
  const body2 = hexToBytes(fixtureHex.replace(/\s+/g, ""));
  const original = spoofWlocResponse;
  // Report the patch result by comparing against a second fresh parse pass.
  const report = {
    kind: result.kind,
    wifiCount: result.wifiCount,
    cellCount: result.cellCount,
    strictError: result.strictError || null,
    responseBytes: result.response.length,
    inputBytes: body2.length,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log("patched body (hex): " + bytesToHex(result.response, 0));
  void original;
}

async function cmdDump(args) {
  if (!args[0]) throw new Error("dump needs a hex file path");
  const hex = (await readFile(args[0], "utf8")).replace(/\s+/g, "");
  const result = spoofWlocResponse(hexToBytes(hex), {
    latitude: args[1],
    longitude: args[2],
  });
  console.log(
    "kind=%s wifi=%d cell=%d bytes=%d",
    result.kind,
    result.wifiCount,
    result.cellCount,
    result.response.length,
  );
}

function showHelp() {
  console.log(
    [
      "usage: node tools/cli.mjs <command> [args]",
      "",
      "commands:",
      "  build <shadowrocket|surge|loon|quantumultx|stash|all> [lat] [lng] [hacc]",
      "  test",
      "  demo [lat] [lng] [hacc]",
      "  dump <hexfile> [lat] [lng]",
      "",
      "defaults: lat=" + DEFAULT_CONFIG.latitude + " lng=" + DEFAULT_CONFIG.longitude + " hacc=" + DEFAULT_CONFIG.horizontalAccuracy,
    ].join("\n"),
  );
}

const commands = { build: cmdBuild, test: cmdTest, demo: cmdDemo, dump: cmdDump };

const [command, ...rest] = process.argv.slice(2);
if (!command || !commands[command]) {
  showHelp();
  process.exitCode = command ? 1 : 0;
} else {
  try {
    await commands[command](rest);
  } catch (err) {
    console.error("error: " + err.message);
    process.exitCode = 1;
  }
}

// Keep the argument helpers reachable for `node --eval` smoke checks.
export { parseArgumentString, resolveConfigUrl };
