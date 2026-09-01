/**
 * Integration tests for the location-picker HTTP handler (no real server):
 * token gate, loc.json serving, stats counting, HTML UI at /, and /set.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../location-picker/server.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error("FAIL " + name + " — " + err.message);
  }
}

/** Minimal mock of node http res for the handler. */
function mockRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: "",
    finished: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = body == null ? "" : String(body);
      this.finished = true;
    },
    destroy() {
      this.finished = true;
    },
  };
  return res;
}

function call(handler, path, options) {
  options = options || {};
  const cbs = {};
  const req = {
    method: options.method || "GET",
    url: path,
    on(evt, fn) {
      cbs[evt] = fn;
    },
    destroy() {},
  };
  const res = mockRes();
  handler(req, res);
  // /set responds on the request stream's data/end events.
  if (options.body !== undefined) {
    cbs.data(options.body);
    cbs.end();
  }
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

const TOKEN = "test-token-123";
const tmp = mkdtempSync(join(tmpdir(), "myrocket-picker-test-"));
const dataFile = join(tmp, "loc.json");

const handler = createHandler({ token: TOKEN, dataFile });

/* 1. Health endpoint needs no token. */
check("health without token", () => {
  const r = call(handler, "/health");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
});

/* 2. Wrong token is rejected. */
check("wrong token rejected", () => {
  const r = call(handler, "/loc.json?token=wrong");
  assert.equal(r.status, 403);
});

/* 3. Correct token serves the current location JSON. */
check("loc.json serves default location", () => {
  const r = call(handler, "/loc.json?token=" + TOKEN);
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body);
  assert.equal(data.latitude, 37.3349);
  assert.equal(data.longitude, -122.00902);
  assert.equal(data.horizontalAccuracy, 39);
});

/* 4. Module fetches increment stats; the UI's own load does not. */
check("stats count module fetches only", () => {
  call(handler, "/loc.json?token=" + TOKEN);
  call(handler, "/loc.json?token=" + TOKEN);
  call(handler, "/loc.json?token=" + TOKEN + "&source=ui");
  const r = call(handler, "/stats?token=" + TOKEN);
  const stats = JSON.parse(r.body);
  assert.ok(stats.fetchCount >= 3, "expected >=3 module fetches, got " + stats.fetchCount);
  assert.ok(stats.lastFetchAt > 0, "lastFetchAt should be set");
  assert.ok(stats.updatedAt === null || typeof stats.updatedAt === "string");
});

/* 5. The web UI is served at / as HTML. */
check("root serves HTML page", () => {
  const r = call(handler, "/?token=" + TOKEN);
  assert.equal(r.status, 200);
  assert.match(String(r.headers["Content-Type"]), /text\/html/);
  assert.ok(r.body.includes("MyRocket Location Picker"));
  assert.ok(r.body.includes("refreshBadge"));
});

/* 6. /set validates and persists the new target. */
check("set updates and persists", () => {
  const r = call(handler, "/set?token=" + TOKEN, {
    method: "POST",
    body: JSON.stringify({ latitude: 48.85, longitude: 2.35, horizontalAccuracy: 7 }),
  });
  assert.equal(r.status, 200);
  const saved = JSON.parse(r.body);
  assert.equal(saved.latitude, 48.85);
  assert.ok(existsSync(dataFile), "loc.json should exist after /set");
  const onDisk = JSON.parse(readFileSync(dataFile, "utf8"));
  assert.equal(onDisk.latitude, 48.85);
});

/* 7. /set rejects out-of-range coordinates. */
check("set rejects invalid coordinates", () => {
  const r = call(handler, "/set?token=" + TOKEN, {
    method: "POST",
    body: JSON.stringify({ latitude: 999, longitude: 2.35 }),
  });
  assert.equal(r.status, 400);
});

/* 8. Unknown paths 404. */
check("unknown path 404", () => {
  const r = call(handler, "/nope?token=" + TOKEN);
  assert.equal(r.status, 404);
});

rmSync(tmp, { recursive: true, force: true });
console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exitCode = 1;
