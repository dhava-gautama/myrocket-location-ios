/**
 * Integration test: run dist/wloc.engine.js inside a mock proxy-app sandbox
 * ($request/$response/$done) for Shadowrocket-style bytes and Loon/QX-style
 * base64 strings.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "../test/hex.mjs";
import { runTests } from "../test/wloc.test.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Evaluate the built bundle and return its $done result. */
function runInSandbox(globals) {
  const source = globals.__ENGINE_SOURCE__;
  const sandbox = {};
  const params = ["$request", "$response", "$argument", "$done", "console", "$httpClient", "$persistentStore"];
  const values = params.map((name) => (name in globals ? globals[name] : undefined));
  const fn = new Function(...params, source + "\n");
  let recorded = { called: false, payload: null };
  values[params.indexOf("$done")] = (payload) => {
    recorded = { called: true, payload };
  };
  fn(...values);
  if (!recorded.called) throw new Error("$done was not called");
  return recorded.payload;
}

const engineSource = await readFile(join(ROOT, "dist", "wloc.engine.js"), "utf8");
const fixtureHex = (await readFile(join(ROOT, "test", "fixtures", "arpc-response.hex"), "utf8")).trim();

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

const ARG = "mode=response&latitude=35.6764&longitude=139.65&horizontalAccuracy=12&failOpen=true&debug=false";

/* 1. Shadowrocket-style: binary body as Uint8Array. */
{
  const bodyBytes = hexToBytes(fixtureHex);
  const result = runInSandbox({
    __ENGINE_SOURCE__: engineSource,
    $response: { bodyBytes },
    $argument: ARG,
    console,
  });
  check("sandbox binary body patched", result && result.body instanceof Uint8Array && result.body.length > 100);
  const text = Buffer.from(result.body).toString("hex");
  check("sandbox binary contains tokyo lat", text.includes("c0bb97a50d"), text.slice(0, 64));
  check("sandbox keeps arpc envelope", text.startsWith("0001"), text.slice(0, 16));
}

/* 2. Loon/QX-style: base64 string body, no bodyBytes. */
{
  const bodyBytes = hexToBytes(fixtureHex);
  const result = runInSandbox({
    __ENGINE_SOURCE__: engineSource,
    $response: { body: base64(bodyBytes) },
    $argument: ARG,
    console,
  });
  check("sandbox base64 patched", result && typeof result.body === "string");
  const decoded = Buffer.from(String(result.body), "base64").toString("hex");
  check("sandbox base64 contains tokyo lat", decoded.includes("c0bb97a50d"), decoded.slice(0, 64));
}

/* 3. Fail-open: garbage body passes through untouched. */
{
  const result = runInSandbox({
    __ENGINE_SOURCE__: engineSource,
    $response: { bodyBytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) },
    $argument: ARG,
  });
  check("sandbox fail-open returns empty $done", result && Object.keys(result).length === 0);
}

/* 4. Disabled switch: pass-through even with a valid body. */
{
  const result = runInSandbox({
    __ENGINE_SOURCE__: engineSource,
    $response: { bodyBytes: hexToBytes(fixtureHex) },
    $argument: "enabled=false&latitude=35.6764&longitude=139.65",
  });
  check("sandbox disabled passes through", result && Object.keys(result).length === 0);
}

/* 5. Prepare pass: Accept-Encoding pinned to identity. */
{
  const result = runInSandbox({
    __ENGINE_SOURCE__: engineSource,
    $request: { headers: { Host: "gs-loc.apple.com" } },
    $argument: "",
  });
  const headerKey = result && result.headers ? Object.keys(result.headers).find((k) => k.toLowerCase() === "accept-encoding") : null;
  check("sandbox prepare sets identity", headerKey && result.headers[headerKey] === "identity", JSON.stringify(result));
}

/* 6. Cron pass: remote config is fetched and cached via $persistentStore. */
{
  const store = {};
  let fetched = null;
  const result = runInSandbox({
    __ENGINE_SOURCE__: engineSource,
    $argument: "configUrl=https%3A%2F%2Fpicker.example%2Floc.json%3Ftoken%3Dabc&debug=false",
    $httpClient: {
      get: (options, callback) => {
        fetched = options.url;
        callback(null, {}, JSON.stringify({ latitude: 48.8566, longitude: 2.3522, horizontalAccuracy: 8 }));
      },
    },
    $persistentStore: {
      read: (key) => store[key] || null,
      write: (key, value) => {
        store[key] = value;
      },
    },
  });
  check("cron called with configUrl", fetched === "https://picker.example/loc.json?token=abc", String(fetched));
  check("cron result is empty", result && Object.keys(result).length === 0);
  check("cron cached the config", Boolean(store.myrocket_remote_cfg), JSON.stringify(Object.keys(store)));
}

/* 7. Response pass uses the cached remote config when configUrl matches. */
{
  const store = {
    myrocket_remote_cfg: JSON.stringify({
      url: "https://picker.example/loc.json?token=abc",
      data: { latitude: 48.8566, longitude: 2.3522, horizontalAccuracy: 8 },
      ts: Date.now(),
    }),
  };
  const result = runInSandbox({
    __ENGINE_SOURCE__: engineSource,
    $response: { bodyBytes: hexToBytes(fixtureHex) },
    $argument: "configUrl=https%3A%2F%2Fpicker.example%2Floc.json%3Ftoken%3Dabc",
    $persistentStore: {
      read: (key) => store[key] || null,
      write: (key, value) => {
        store[key] = value;
      },
    },
    console,
  });
  const text = Buffer.from(result.body).toString("hex");
  // Paris via BigInt-verified varints: 48.8566 -> e082d59912, 2.3522 -> a0d89470.
  check("remote config overrides lat/lng", text.includes("e082d59912") && text.includes("a0d89470"), text.slice(0, 80));
}

/* 8. Base64 round-trip integrity for QX. */
{
  const bodyBytes = hexToBytes(fixtureHex);
  const result = runInSandbox({
    __ENGINE_SOURCE__: engineSource,
    $response: { body: base64(bodyBytes) },
    $argument: "latitude=1.5&longitude=2.5",
    console,
  });
  const decoded = new Uint8Array(Buffer.from(String(result.body), "base64"));
  const text = Buffer.from(decoded).toString("hex");
  // BigInt-verified varints: 1.5 -> 80a3c347, 2.5 -> 80e59a77.
  check("qx base64 contains paris lat", text.includes("80a3c347") && text.includes("80e59a77"), text.slice(0, 80));
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exitCode = 1;
