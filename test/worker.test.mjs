/**
 * Tests for the Cloudflare Worker picker backend. Runs on plain Node (no
 * Miniflare) by mocking the KV namespace and calling the exported
 * handleRequest(request, env) directly.
 */

import { strict as assert } from "node:assert";
import { handleRequest, mapNominatimResults, validateLocation } from "../location-picker/worker.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
    })
    .catch((err) => {
      failed += 1;
      console.error("FAIL " + name + " — " + err.message);
    });
}

/** In-memory KV namespace with the subset of the API the worker uses. */
function mockKV(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    get: (key) => Promise.resolve(map.has(key) ? map.get(key) : null),
    put: (key, value) => {
      map.set(key, String(value));
      return Promise.resolve();
    },
    _map: map,
  };
}

function makeRequest(path, init) {
  return new Request("https://picker.example.com" + path, init);
}

const ENV = { TOKEN: "test-token", CONFIG: mockKV() };

async function run(tests) {
  for (const [name, fn] of tests) await check(name, fn);
  console.log(passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

await run([
  ["health needs no token", async () => {
    const res = await handleRequest(makeRequest("/health"), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }],

  ["rejects wrong and missing token", async () => {
    assert.equal((await handleRequest(makeRequest("/loc.json"), ENV)).status, 403);
    assert.equal((await handleRequest(makeRequest("/loc.json?token=wrong"), ENV)).status, 403);
    assert.equal((await handleRequest(makeRequest("/set?token=wrong", { method: "POST", body: "{}" }))).status, 403);
  }],

  ["default location before anything is saved", async () => {
    const res = await handleRequest(makeRequest("/loc.json?token=test-token"), ENV);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.latitude, 37.3349);
    assert.equal(data.longitude, -122.00902);
    assert.equal(data.horizontalAccuracy, 39);
  }],

  ["set then read back via loc.json", async () => {
    const res = await handleRequest(makeRequest("/set?token=test-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latitude: 35.6764, longitude: 139.65, horizontalAccuracy: 12 }),
    }), ENV);
    assert.equal(res.status, 200);
    await res.json(); // body echoes the saved record incl. updatedAt, like server.mjs
    const read = await handleRequest(makeRequest("/loc.json?token=test-token"), ENV);
    const data = await read.json();
    assert.equal(data.latitude, 35.6764);
    assert.equal(data.longitude, 139.65);
    assert.equal(data.horizontalAccuracy, 12);
    assert.ok(data.updatedAt, "stored record carries updatedAt");
  }],

  ["rejects out-of-range coordinates", async () => {
    const res = await handleRequest(makeRequest("/set?token=test-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latitude: 999, longitude: 0, horizontalAccuracy: 1 }),
    }), ENV);
    assert.equal(res.status, 400);
  }],

  ["rejects invalid JSON body", async () => {
    const res = await handleRequest(makeRequest("/set?token=test-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    }), ENV);
    assert.equal(res.status, 400);
  }],

  ["stats counts module fetches with throttling", async () => {
    const env = { TOKEN: "test-token", CONFIG: mockKV() };
    await handleRequest(makeRequest("/loc.json?token=test-token"), env); // fetch 1 -> write
    await handleRequest(makeRequest("/loc.json?token=test-token"), env); // fetch 2 -> throttled
    const res = await handleRequest(makeRequest("/stats?token=test-token"), env);
    const stats = await res.json();
    assert.equal(stats.fetchCount, 1, "second fetch inside throttle window is not counted");
    assert.ok(stats.lastFetchAt > 0, "lastFetchAt recorded");
    // UI loads never count.
    await handleRequest(makeRequest("/loc.json?token=test-token&source=ui"), env);
    const res2 = await handleRequest(makeRequest("/stats?token=test-token"), env);
    assert.equal((await res2.json()).fetchCount, 1);
  }],

  ["missing KV binding fails with a helpful 500", async () => {
    const res = await handleRequest(makeRequest("/loc.json?token=test-token"), { TOKEN: "test-token" });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /CONFIG/);
  }],

  ["UI page served at / with search and save controls", async () => {
    const res = await handleRequest(makeRequest("/?token=test-token"), ENV);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="query"/);
    assert.match(html, /id="save"/);
    assert.match(html, /id="configUrl"/);
  }],

  ["search maps Nominatim payload and passes User-Agent", async () => {
    const calls = [];
    const env = {
      TOKEN: "test-token",
      CONFIG: mockKV(),
      fetchImpl: (url, init) => {
        calls.push({ url, ua: init.headers["User-Agent"] });
        return Promise.resolve(new Response(JSON.stringify([
          { display_name: "Tokyo Tower, Japan", lat: "35.6586", lon: "139.7454" },
        ]), { status: 200 }));
      },
    };
    const res = await handleRequest(makeRequest("/search?token=test-token&q=Tokyo%20Tower"), env);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].latitude, 35.6586);
    assert.equal(list[0].longitude, 139.7454);
    assert.match(list[0].label, /Tokyo Tower/);
    assert.equal(calls[0].url.includes("q=Tokyo%20Tower"), true);
    assert.match(calls[0].ua, /MyRocketLocationPicker/);
  }],

  ["search with empty q returns 400", async () => {
    const res = await handleRequest(makeRequest("/search?token=test-token&q="), ENV);
    assert.equal(res.status, 400);
  }],

  ["search upstream failure returns 502", async () => {
    const env = {
      TOKEN: "test-token",
      CONFIG: mockKV(),
      fetchImpl: () => Promise.reject(new Error("boom")),
    };
    const res = await handleRequest(makeRequest("/search?token=test-token&q=x"), env);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /geocoder unreachable/);
  }],

  ["mapNominatimResults ignores malformed entries", () => {
    assert.deepEqual(mapNominatimResults(null), []);
    assert.deepEqual(mapNominatimResults([{ lat: "x", lon: "y" }]), []);
    const ok = mapNominatimResults([{ display_name: "A", lat: "1.5", lon: "2.5" }]);
    assert.deepEqual(ok, [{ label: "A", latitude: 1.5, longitude: 2.5 }]);
  }],

  ["validateLocation matches server rules", () => {
    assert.ok(validateLocation({ latitude: 0, longitude: 0, horizontalAccuracy: 5 }));
    assert.equal(validateLocation({ latitude: 90.5 }), null);
    assert.equal(validateLocation({ longitude: -180.5 }), null);
    assert.equal(validateLocation({ horizontalAccuracy: -1 }), null);
  }],
]);
