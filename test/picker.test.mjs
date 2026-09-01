/**
 * Integration tests for the location-picker HTTP handler (no real server):
 * token gate, loc.json serving, stats counting, HTML UI at /, /set, and
 * /search address geocoding via an injected fetch.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../location-picker/server.mjs";

let passed = 0;
let failed = 0;
let ran = 0;

/** Sequential sync/async test runner so handler state never races. */
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
    })
    .catch((err) => {
      failed += 1;
      console.error("FAIL " + name + " — " + err.message);
    })
    .then(() => {
      ran += 1;
      if (ran === TOTAL) {
        console.log("\n" + passed + " passed, " + failed + " failed");
        rmSync(tmp, { recursive: true, force: true });
        if (failed > 0) process.exitCode = 1;
      }
    });
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

/**
 * The /search handler responds asynchronously (fetch promise chain): invoke
 * once, then flush the event loop until THIS response has a status (bounded).
 */
async function callAsync(handler, path, options) {
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
  for (let i = 0; i < 50 && res.statusCode === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (res.statusCode === 0) throw new Error("handler never responded for " + path);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

const TOTAL = 10;
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
  const r = call(handler, "/loc.json?token=" + encodeURIComponent("not-the-token"));
  assert.equal(r.status, 403);
});

/* 3. Correct token serves the current location JSON. */
check("loc.json serves default location", () => {
  const r = call(handler, "/loc.json?token=" + encodeURIComponent(TOKEN));
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body);
  assert.equal(data.latitude, 37.3349);
  assert.equal(data.longitude, -122.00902);
  assert.equal(data.horizontalAccuracy, 39);
});

/* 4. Module fetches increment stats; the UI's own load does not. */
check("stats count module fetches only", () => {
  call(handler, "/loc.json?token=" + encodeURIComponent(TOKEN));
  call(handler, "/loc.json?token=" + encodeURIComponent(TOKEN));
  call(handler, "/loc.json?token=" + encodeURIComponent(TOKEN) + "&source=ui");
  const r = call(handler, "/stats?token=" + encodeURIComponent(TOKEN));
  const stats = JSON.parse(r.body);
  assert.ok(stats.fetchCount >= 2, "expected >=2 module fetches, got " + stats.fetchCount);
  assert.ok(stats.lastFetchAt > 0, "lastFetchAt should be set");
  assert.ok(stats.updatedAt === null || typeof stats.updatedAt === "string");
});

/* 5. The web UI is served at / as HTML. */
check("root serves HTML page", () => {
  const r = call(handler, "/?token=" + encodeURIComponent(TOKEN));
  assert.equal(r.status, 200);
  assert.match(String(r.headers["Content-Type"]), /text\/html/);
  assert.ok(r.body.includes("MyRocket Location Picker"));
  assert.ok(r.body.includes("refreshBadge"));
});

/* 6. /set validates and persists the new target. */
check("set updates and persists", () => {
  const r = call(handler, "/set?token=" + encodeURIComponent(TOKEN), {
    method: "POST",
    body: JSON.stringify({ latitude: 48.85, longitude:  2.35, horizontalAccuracy: 7 }),
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
  const r = call(handler, "/set?token=" + encodeURIComponent(TOKEN), {
    method: "POST",
    body: JSON.stringify({ latitude: 999, longitude: 2.35 }),
  });
  assert.equal(r.status, 400);
});

/* 8. Unknown paths 404. */
check("unknown path 404", () => {
  const r = call(handler, "/nope?token=" + encodeURIComponent(TOKEN));
  assert.equal(r.status, 404);
});

/* 9. /search geocodes through the injected fetch and maps the payload. */
check("search maps Nominatim results via fetchImpl", async () => {
  const calls = [];
  const searchHandler = createHandler({
    token: TOKEN,
    dataFile,
    fetchImpl: (url, init) => {
      calls.push({ url, ua: init.headers["User-Agent"] });
      return Promise.resolve({
        json: () => Promise.resolve([{ display_name: "Eiffel Tower, Paris", lat: "48.8584", lon: "2.2945" }]),
      });
    },
  });
  const r = await callAsync(searchHandler, "/search?token=" + encodeURIComponent(TOKEN) + "&q=" + encodeURIComponent("Eiffel Tower"));
  assert.equal(r.status, 200);
  const list = JSON.parse(r.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].latitude, 48.8584);
  assert.equal(list[0].longitude, 2.2945);
  assert.match(list[0].label, /Eiffel/);
  assert.equal(calls[0].url.includes("q=Eiffel%20Tower"), true);
  assert.match(calls[0].ua, /MyRocketLocationPicker/);
});

/* 10. /search without q is a 400; UI page includes the search box. */
check("search validation and UI wiring", () => {
  assert.equal(call(handler, "/search?token=" + encodeURIComponent(TOKEN) + "&q=").status, 400);
  const page = call(handler, "/?token=" + encodeURIComponent(TOKEN));
  assert.ok(page.body.includes('id="query"'), "page should contain the search input");
});
