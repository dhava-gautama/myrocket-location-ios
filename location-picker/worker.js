/**
 * MyRocket location picker — Cloudflare Worker edition (single file).
 *
 * Serves the same API as location-picker/server.mjs, so the module's
 * `configUrl` argument works unchanged against either backend:
 *   GET  /health              -> {"ok":true}            (no token needed)
 *   GET  /loc.json?token=...  -> current target JSON    (counts a fetch)
 *   GET  /stats?token=...     -> badge stats for the UI
 *   GET  /search?token=...&q=address -> geocoded candidates (Nominatim)
 *   POST /set?token=...       -> body {"latitude","longitude","horizontalAccuracy"}
 *   GET  /?token=...          -> picker UI (search box + coordinate form)
 *
 * Deploy from the Cloudflare dashboard with no command line at all:
 *   1. dash.cloudflare.com -> Workers & Pages -> Create -> "Hello world" -> Deploy.
 *   2. Edit code -> replace the whole file with this one -> Deploy.
 *   3. Settings -> Bindings -> KV -> add a namespace, variable name CONFIG.
 *   4. Settings -> Variables and Secrets -> add TOKEN (long random string,
 *      e.g. `openssl rand -hex 24`; any password generator works too).
 *   5. Open https://<worker-name>.<your-subdomain>.workers.dev/?token=<TOKEN>.
 *
 * Free-tier notes: KV is the only binding (100k reads/day, 1k writes/day on
 * the free plan). Fetch-badge stats are throttled to one KV write per five
 * minutes so module fetches never burn the write quota; the badge therefore
 * shows minute granularity, not per-request precision.
 */

const DEFAULT_LOCATION = { latitude: 37.3349, longitude: -122.00902, horizontalAccuracy: 39 };
const LOCATION_KEY = "location";
const STATS_KEY = "stats";
const STATS_THROTTLE_MS = 5 * 60 * 1000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MyRocket Location Picker</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0e14; color: #e6e8ee; margin: 0; padding: 2rem; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.3rem; font-weight: 600; }
  .card { background: #151a23; border: 1px solid #232a36; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
  label { display: block; font-size: 0.8rem; color: #8b93a5; margin: 0.75rem 0 0.25rem; }
  input { width: 100%; background: #0b0e14; color: #e6e8ee; border: 1px solid #2a3240; border-radius: 8px; padding: 0.6rem 0.75rem; font-size: 1rem; }
  button { margin-top: 1rem; background: #2f6fed; border: 0; color: white; border-radius: 8px; padding: 0.6rem 1.2rem; font-size: 0.95rem; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .status { font-size: 0.85rem; color: #8b93a5; margin-top: 0.75rem; min-height: 1.2em; }
  .badge { font-size: 0.85rem; color: #8b93a5; margin-top: 0.5rem; }
  .badge .live { color: #34c759; }
  .row { display: flex; gap: 0.75rem; } .row > div { flex: 1; }
  code { background: #0b0e14; padding: 0.2rem 0.4rem; border-radius: 6px; font-size: 0.85rem; word-break: break-all; }
  .result { padding: 0.5rem 0.6rem; border: 1px solid #2a3240; border-radius: 8px; margin-top: 0.5rem; font-size: 0.85rem; cursor: pointer; }
  .result:hover { border-color: #2f6fed; }
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
var qs = new URLSearchParams(location.search);
var TOKEN = qs.get('token') || '';
document.getElementById('configUrl').textContent = location.origin + '/loc.json?token=' + TOKEN;
function ago(ts) {
  if (!ts) return 'never';
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}
function load() {
  fetch('/loc.json?token=' + TOKEN + '&source=ui').then(function (r) { return r.json(); }).then(function (data) {
    document.getElementById('lat').value = data.latitude;
    document.getElementById('lng').value = data.longitude;
    document.getElementById('hacc').value = data.horizontalAccuracy;
  }).catch(function () {});
}
function refreshBadge() {
  var el = document.getElementById('badge');
  fetch('/stats?token=' + TOKEN).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
    if (!s) { el.textContent = ''; return; }
    el.innerHTML = s.lastFetchAt
      ? '<span class="live">●</span> module last fetched ' + ago(s.lastFetchAt) + ' · ' + s.fetchCount + ' since deploy'
      : 'no module has fetched the config yet';
  }).catch(function () { el.textContent = ''; });
}
function renderResults(list) {
  var box = document.getElementById('results');
  box.textContent = '';
  list.forEach(function (item) {
    var div = document.createElement('div');
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
document.getElementById('search').addEventListener('click', function () {
  var button = this;
  var status = document.getElementById('searchStatus');
  var q = document.getElementById('query').value.trim();
  if (!q) { status.textContent = 'Type an address first.'; return; }
  button.disabled = true;
  status.textContent = 'Searching…';
  fetch('/search?token=' + TOKEN + '&q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (list) {
    if (!Array.isArray(list) || list.length === 0) { status.textContent = 'No matches.'; return; }
    status.textContent = 'Tap a result to fill the form:';
    renderResults(list);
  }).catch(function (err) {
    status.textContent = 'Search failed: ' + err.message;
  }).finally(function () { button.disabled = false; });
});
document.getElementById('save').addEventListener('click', function () {
  var status = document.getElementById('status');
  var button = this;
  button.disabled = true;
  fetch('/set?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      latitude: parseFloat(document.getElementById('lat').value),
      longitude: parseFloat(document.getElementById('lng').value),
      horizontalAccuracy: parseInt(document.getElementById('hacc').value || '39', 10),
    }),
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    status.textContent = 'Saved. Modules refresh it inline — the next location request uses it.';
    refreshBadge();
  }).catch(function (err) {
    status.textContent = 'Save failed: ' + err.message;
  }).finally(function () { button.disabled = false; });
});
load();
refreshBadge();
setInterval(refreshBadge, 5000);
</script>
</body>
</html>
`;

/**
 * Same validation rules as location-picker/server.mjs: finite lat/lng inside
 * WGS-84 bounds, non-negative integer accuracy. Returns null when invalid.
 */
export function validateLocation(body) {
  const latitude = Number(body && body.latitude);
  const longitude = Number(body && body.longitude);
  const horizontalAccuracy = Math.trunc(Number((body && body.horizontalAccuracy) || 39));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (!Number.isFinite(horizontalAccuracy) || horizontalAccuracy < 0) return null;
  return { latitude, longitude, horizontalAccuracy, updatedAt: new Date().toISOString() };
}

/**
 * Flatten a Nominatim search response into [{label, latitude, longitude}].
 * Exported so tests can pin the mapping without network access.
 */
export function mapNominatimResults(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.map((item) => ({
    label: String(item.display_name || "unnamed"),
    latitude: Number(item.lat),
    longitude: Number(item.lon),
  })).filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Minimal KV shim shape: env.CONFIG.get/put. Documented for mock envs. */
function missingBinding() {
  return json({ error: "KV namespace CONFIG is not bound — see the header comment for dashboard setup steps" }, 500);
}

/**
 * Route the request. Exported for tests: build a Request and a mock env
 * ({ TOKEN, CONFIG: { get, put }, fetchImpl }) and call directly.
 */
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const store = env && env.CONFIG;
  const fetchImpl = (env && env.fetchImpl) || fetch;

  if (url.pathname === "/health") return json({ ok: true });

  if (token !== String(env && env.TOKEN || "")) {
    return json({ error: "invalid token" }, 403);
  }

  if (!store || typeof store.get !== "function") {
    return missingBinding();
  }

  if (url.pathname === "/loc.json" && request.method === "GET") {
    const raw = await store.get(LOCATION_KEY);
    let location = DEFAULT_LOCATION;
    if (raw) {
      try { location = JSON.parse(raw); } catch { location = DEFAULT_LOCATION; }
    }
    // Badge stats: throttled so per-request module fetches stay inside the
    // free-tier KV write quota.
    if (url.searchParams.get("source") !== "ui") {
      const statsRaw = await store.get(STATS_KEY);
      let stats = { fetchCount: 0, lastFetchAt: 0 };
      if (statsRaw) {
        try { stats = JSON.parse(statsRaw); } catch { stats = { fetchCount: 0, lastFetchAt: 0 }; }
      }
      const now = Date.now();
      if (now - Number(stats.lastFetchAt || 0) > STATS_THROTTLE_MS) {
        stats.fetchCount = Number(stats.fetchCount || 0) + 1;
        stats.lastFetchAt = now;
        await store.put(STATS_KEY, JSON.stringify(stats));
      }
    }
    return json(location);
  }

  if (url.pathname === "/stats" && request.method === "GET") {
    let locationUpdatedAt = null;
    const raw = await store.get(LOCATION_KEY);
    if (raw) {
      try { locationUpdatedAt = JSON.parse(raw).updatedAt || null; } catch { locationUpdatedAt = null; }
    }
    let stats = { fetchCount: 0, lastFetchAt: null };
    const statsRaw = await store.get(STATS_KEY);
    if (statsRaw) {
      try { stats = JSON.parse(statsRaw); } catch { stats = { fetchCount: 0, lastFetchAt: null }; }
    }
    return json({ fetchCount: stats.fetchCount, lastFetchAt: stats.lastFetchAt, updatedAt: locationUpdatedAt });
  }

  if (url.pathname === "/search" && request.method === "GET") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) return json({ error: "missing q" }, 400);
    const endpoint = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=" +
      encodeURIComponent(query);
    let payload;
    try {
      // Nominatim's usage policy: identify the app with a real User-Agent.
      const res = await fetchImpl(endpoint, { headers: { "User-Agent": "MyRocketLocationPicker/1.0 (module config service)" } });
      payload = await res.json();
    } catch (err) {
      return json({ error: "geocoder unreachable: " + err.message }, 502);
    }
    return json(mapNominatimResults(payload));
  }

  if (url.pathname === "/set" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
    const parsed = validateLocation(body);
    if (!parsed) return json({ error: "invalid coordinates" }, 400);
    await store.put(LOCATION_KEY, JSON.stringify(parsed, null, 2));
    return json(parsed);
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return new Response(PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
