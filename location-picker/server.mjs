#!/usr/bin/env node
/**
 * MyRocket location picker — self-hosted config service.
 *
 * Serves /loc.json?token=... with the current spoof target so proxy-app
 * scripts can pick up coordinate changes without reinstalling modules.
 * The same page doubles as a web UI for picking coordinates on a map,
 * updating the stored location, and (optionally) geocoding an address.
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
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(HERE, "loc.json");

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("MyRocket picker: TOKEN environment variable is required (openssl rand -hex 24)");
  process.exit(1);
}
const PORT = Number(process.env.PORT || 8080);
const CERT = process.env.CERT || "";
const KEY = process.env.KEY || "";

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
  .row { display: flex; gap: 0.75rem; } .row > div { flex: 1; }
  code { background: #0b0e14; padding: 0.2rem 0.4rem; border-radius: 6px; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
  <h1>MyRocket Location Picker</h1>
  <div class="card">
    <div class="row">
      <div><label>Latitude</label><input id="lat" inputmode="decimal"></div>
      <div><label>Longitude</label><input id="lng" inputmode="decimal"></div>
    </div>
    <label>Horizontal accuracy (meters)</label>
    <input id="hacc" inputmode="numeric">
    <button id="save">Save target</button>
    <div class="status" id="status"></div>
  </div>
  <div class="card">
    <p style="margin-top:0;font-size:0.85rem;color:#8b93a5">Point your module's <code>configUrl</code> at:</p>
    <code id="configUrl"></code>
  </div>
</main>
<script>
const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token') || '';
document.getElementById('configUrl').textContent = location.origin + '/loc.json?token=' + TOKEN;
async function load() {
  const res = await fetch('/loc.json?token=' + encodeURIComponent(TOKEN));
  const data = await res.json();
  document.getElementById('lat').value = data.latitude;
  document.getElementById('lng').value = data.longitude;
  document.getElementById('hacc').value = data.horizontalAccuracy;
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
    status.textContent = 'Saved. Cached module configs pick it up within 5 minutes.';
  } catch (err) {
    status.textContent = 'Save failed: ' + err.message;
  } finally {
    button.disabled = false;
  }
});
load().catch(() => {});
</script>
</body>
</html>
`;

function readLocation() {
  if (existsSync(DATA_FILE)) {
    try {
      return JSON.parse(readFileSync(DATA_FILE, "utf8"));
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
  const token = url.searchParams.get("token") || "";

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (token !== TOKEN) {
    sendJson(res, 403, { error: "invalid token" });
    return;
  }
  if (url.pathname === "/loc.json" || url.pathname === "/") {
    sendJson(res, 200, readLocation());
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
        writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2) + "\n");
        sendJson(res, 200, parsed);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
};

const server =
  CERT && KEY
    ? createHttpsServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, handler)
    : createServer(handler);

server.listen(PORT, () => {
  const scheme = CERT && KEY ? "https" : "http";
  console.log(`MyRocket picker listening on ${scheme}://0.0.0.0:${PORT}`);
  console.log(`config URL: ${scheme}://<host>:${PORT}/loc.json?token=<TOKEN>`);
});
