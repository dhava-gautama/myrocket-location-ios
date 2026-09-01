#!/usr/bin/env node
/**
 * MyRocket location picker — self-hosted config service.
 *
 * Serves /loc.json?token=... with the current spoof target so proxy-app
 * scripts can pick up coordinate changes without reinstalling modules.
 * The same page doubles as a web UI for editing the stored location and
 * shows when a module last fetched the config.
 *
 * Environment:
 *   TOKEN  required, access token; the process exits without it
 *   PORT   optional, defaults to 8080
 *   CERT   optional, TLS fullchain path (with KEY enables HTTPS)
 *   KEY    optional, TLS private key path
 */

import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MyRocket Location Picker</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0e14; color: #e6e8ee; margin: 0; padding: 2rem; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.3rem; font-weight: 600; }
  .card { background: #151a23; border: 1px solid #232a36; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
  label { display: block; font-size: 0.8rem; color: #8b93a5; margin: 0.75rem 0 0.25rem; }
  input { width: 100%; box-sizing: border-box; background: #0b0e14; color: #e6e8ee; border: 1px solid #2a3240; border-radius: 8px; padding: 0.6rem 0.75rem; font-size: 1rem; }
  button { margin-top: 1rem; background: #2f6fed; border: 0; color: white; border-radius: 8px; padding: 0.6rem 1.2rem; font-size: 0.95rem; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .status { font-size: 0.85rem; color: #8b93a5; margin-top: 0.75rem; min-height: 1.2em; }
  .badge { font-size: 0.85rem; color: #8b93a5; margin-top: 0.5rem; }
  .badge .live { color: #34c759; }
  .row { display: flex; gap: 0.75rem; } .row > div { flex: 1; }
  .result { padding: 0.5rem 0.6rem; border: 1px solid #2a3240; border-radius: 8px; margin-top: 0.5rem; font-size: 0.85rem; cursor: pointer; }
  .result:hover { border-color: #2f6fed; }
  code { background: #0b0e14; padding: 0.2rem 0.4rem; border-radius: 6px; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
  <h1>MyRocket Location Picker</h1>
  <div class="card">
    <label>Search an address</label>
    <input id="query" placeholder="e.g. Tokyo Tower">
    <button id="search">Search</button>
    <div class="status" id="searchStatus"></div>
    <div id="results"></div>
  </div>
  <div class="card">
    <div class="row">
      <div><label>Latitude</label><input id="lat" inputmode="decimal"></div>
      <div><label>Longitude</label><input id="lng" inputmode="decimal"></div>
    </div>
    <label>Horizontal accuracy (meters)</label>
    <input id="hacc" inputmode="numeric">
    <button id="save">Save target</button>
    <div class="status" id="status"></div>
    <div class="badge" id="badge"></div>
  </div>
  <div class="card">
    <p style="margin-top:0;font-size:0.85rem;color:#8b93a5">Point your module's <code>configUrl</code> at:</p>
    <code id="configUrl"></code>
  </div>
</main>
<script>
const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token') || '';
document.getElementById('configUrl').textContent = location.origin + '/loc.json?token=' + encodeURIComponent(TOKEN);
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}
function renderResults(list) {
  const box = document.getElementById('results');
  box.textContent = '';
  list.forEach(function (item) {
    const div = document.createElement('div');
    div.className = 'result';
    div.textContent = item.label + ' (' + item.latitude + ', ' + item.longitude + ')';
    div.addEventListener('click', function () {
      document.getElementById('lat').value = item.latitude;
      document.getElementById('lng').value = item.longitude;
      document.getElementById('status').textContent = 'Coordinates filled in — press Save target.';
    });
    box.appendChild(div);
  });
}
document.getElementById('search').addEventListener('click', async () => {
  const button = document.getElementById('search');
  const status = document.getElementById('searchStatus');
  const q = document.getElementById('query').value.trim();
  if (!q) { status.textContent = 'Type an address first.'; return; }
  button.disabled = true;
  status.textContent = 'Searching…';
  try {
    const res = await fetch('/search?token=' + TOKEN + '&q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) { status.textContent = 'No matches.'; return; }
    status.textContent = 'Tap a result to fill the form:';
    renderResults(list);
  } catch (err) {
    status.textContent = 'Search failed: ' + err.message;
  } finally {
    button.disabled = false;
  }
});
async function load() {
  const res = await fetch('/loc.json?token=' + encodeURIComponent(TOKEN) + '&source=ui');
  const data = await res.json();
  document.getElementById('lat').value = data.latitude;
  document.getElementById('lng').value = data.longitude;
  document.getElementById('hacc').value = data.horizontalAccuracy;
}
async function refreshBadge() {
  const el = document.getElementById('badge');
  try {
    const res = await fetch('/stats?token=' + encodeURIComponent(TOKEN));
    if (!res.ok) { el.textContent = ''; return; }
    const s = await res.json();
    el.innerHTML = s.lastFetchAt
      ? '<span class="live">●</span> module last fetched ' + ago(s.lastFetchAt) + ' · ' + s.fetchCount + ' since restart'
      : 'no module has fetched the config yet';
  } catch (err) {
    el.textContent = '';
  }
}
document.getElementById('save').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const button = document.getElementById('save');
  button.disabled = true;
  try {
    const res = await fetch('/set?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latitude: parseFloat(document.getElementById('lat').value),
        longitude: parseFloat(document.getElementById('lng').value),
        horizontalAccuracy: parseInt(document.getElementById('hacc').value || '39', 10),
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    status.textContent = 'Saved. Modules refresh it inline — the next location request uses it.';
    refreshBadge();
  } catch (err) {
    status.textContent = 'Save failed: ' + err.message;
  } finally {
    button.disabled = false;
  }
});
load().catch(() => {});
refreshBadge();
setInterval(refreshBadge, 5000);
</script>
</body>
</html>
`;

/**
 * Flatten a Nominatim search response into [{label, latitude, longitude}].
 * Exported so tests can pin the mapping without network access. Mirrors
 * location-picker/worker.js so both backends behave identically.
 */
export function mapNominatimResults(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.map((item) => ({
    label: String(item.display_name || "unnamed"),
    latitude: Number(item.lat),
    longitude: Number(item.lon),
  })).filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
}

/**
 * Build the request handler plus fetch stats. Exported for tests; the CLI
 * entry below wires it to a real server with env credentials.
 *
 * options.fetchImpl overrides the global fetch used by /search so tests run
 * without network access.
 */
export function createHandler(options) {
  const token = String(options.token || "");
  const dataFile = options.dataFile;
  const fetchImpl = options.fetchImpl || fetch;

  const stats = { fetchCount: 0, lastFetchAt: null };

  function readLocation() {
    if (dataFile && existsSync(dataFile)) {
      try {
        return JSON.parse(readFileSync(dataFile, "utf8"));
      } catch {
        // fall through to default
      }
    }
    return { latitude: 37.3349, longitude: -122.00902, horizontalAccuracy: 39 };
  }

  function validLocation(body) {
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const horizontalAccuracy = Math.trunc(Number(body.horizontalAccuracy || 39));
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    if (!Number.isFinite(horizontalAccuracy) || horizontalAccuracy < 0) return null;
    return { latitude, longitude, horizontalAccuracy, updatedAt: new Date().toISOString() };
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  const handler = (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const givenToken = url.searchParams.get("token") || "";

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (givenToken !== token) {
      sendJson(res, 403, { error: "invalid token" });
      return;
    }
    if (url.pathname === "/loc.json") {
      // source=ui marks the picker page's own load(); only real module
      // fetches count toward the badge.
      if (url.searchParams.get("source") !== "ui") {
        stats.fetchCount += 1;
        stats.lastFetchAt = Date.now();
      }
      sendJson(res, 200, readLocation());
      return;
    }
    if (url.pathname === "/stats") {
      sendJson(res, 200, {
        fetchCount: stats.fetchCount,
        lastFetchAt: stats.lastFetchAt,
        updatedAt: readLocation().updatedAt || null,
      });
      return;
    }
    if (url.pathname === "/set" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 10000) req.destroy();
      });
      req.on("end", () => {
        try {
          const parsed = validLocation(JSON.parse(raw || "{}"));
          if (!parsed) {
            sendJson(res, 400, { error: "invalid coordinates" });
            return;
          }
          writeFileSync(dataFile, JSON.stringify(parsed, null, 2) + "\n");
          sendJson(res, 200, parsed);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
        }
      });
      return;
    }
    if (url.pathname === "/search" && req.method === "GET") {
      const query = (url.searchParams.get("q") || "").trim();
      if (!query) {
        sendJson(res, 400, { error: "missing q" });
        return;
      }
      // Nominatim's usage policy requires an identifying User-Agent.
      const endpoint = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=" +
        encodeURIComponent(query);
      fetchImpl(endpoint, { headers: { "User-Agent": "MyRocketLocationPicker/1.0 (module config service)" } })
        .then((upstream) => upstream.json())
        .then((payload) => sendJson(res, 200, mapNominatimResults(payload)))
        .catch((err) => sendJson(res, 502, { error: "geocoder unreachable: " + err.message }));
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  };

  handler.stats = stats;
  return handler;
}

/* Main entry: only when executed directly (node location-picker/server.mjs). */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const TOKEN = process.env.TOKEN;
  if (!TOKEN) {
    console.error("MyRocket picker: TOKEN environment variable is required (openssl rand -hex 24)");
    process.exit(1);
  }
  const PORT = Number(process.env.PORT || 8080);
  const CERT = process.env.CERT || "";
  const KEY = process.env.KEY || "";
  const HERE = dirname(fileURLToPath(import.meta.url));
  const DATA_FILE = join(HERE, "loc.json");

  const handler = createHandler({ token: TOKEN, dataFile: DATA_FILE });

  const server =
    CERT && KEY
      ? createHttpsServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, handler)
      : createServer(handler);

  server.listen(PORT, () => {
    const scheme = CERT && KEY ? "https" : "http";
    console.log(`MyRocket picker listening on ${scheme}://0.0.0.0:${PORT}`);
    console.log(`config URL: ${scheme}://<host>:${PORT}/loc.json?token=***`);
  });
}
