#!/usr/bin/env node
/**
 * Build dist/wloc.engine.js: engine + runtime adapter in one portable file
 * that parses on iOS 12+ JavaScriptCore (no BigInt, no optional chaining).
 *
 * The engine keeps `export` keywords (it is also imported by Node tests), so
 * the build strips them for the combined artifact.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const engineSource = await readFile(join(ROOT, "core", "wloc.mjs"), "utf8");
const runtimeSource = await readFile(join(ROOT, "core", "runtime.js"), "utf8");

const stripped = engineSource
  .replace(/^\s*export var /gm, "var ")
  .replace(/^\s*export function /gm, "function ");

const banner = [
  "/*",
  " * MyRocket Location Spoofer — generated file, do not edit.",
  " * Source: core/wloc.mjs (engine) + core/runtime.js (adapter)",
  " * Build:  node tools/build-dist.mjs",
  " */",
  "",
].join("\n");

const combined = banner + "(function () {\n\"use strict\";\n" + stripped + "\n" + runtimeSource + "\n})();\n";

export async function buildDist() {
  await mkdir(DIST, { recursive: true });
  const target = join(DIST, "wloc.engine.js");
  await writeFile(target, combined);
  console.log("wrote dist/wloc.engine.js (" + combined.length + " bytes)");
  return target;
}

/* Build directly when executed. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildDist();
}
