# MyRocket Location Spoofer

Spoof your iPhone's location without a jailbreak, a computer, or a developer
account. You install a module in a proxy app from the App Store, and the phone
reports wherever you choose — Apple Maps, Find My-style apps, and anything else
using network location all follow along.

Works on Shadowrocket, Surge, Loon, Quantumult X, and Stash. Everything below
happens **on the iPhone only**.

---

## How it works (30 seconds)

Your phone asks Apple's servers "I can see these Wi-Fi networks and cell towers
— where am I?" The proxy app intercepts Apple's answer and rewrites the
coordinates to your chosen spot. iOS never knows. Nothing is installed system-
wide; remove the module and everything is back to normal.

---

## Setup (about 10 minutes, all on the iPhone)

### Step 1 — Install a proxy app

Any one of these from the App Store: **Shadowrocket** ($2.99, most popular),
Surge, Loon, Quantumult X, or Stash. This guide shows Shadowrocket; the others
work the same way (file names in step 4 differ).

### Step 2 — Turn on HTTPS decryption

1. In Shadowrocket: **Settings → HTTPS Decrypt** → toggle on.
2. Tap the cert, allow the install, then go to **iOS Settings → General → VPN
   & Device Management** and install the certificate.
3. Still in iOS Settings, go to **General → About → Certificate Trust
   Settings** and turn on **full trust** for the certificate. (People skip
   this one constantly — if spoofing "doesn't work", check this first.)

### Step 3 — Add the module

1. In Shadowrocket: **Config → +** (top right).
2. Paste this URL exactly:

   ```
   https://raw.githubusercontent.com/dhava-gautama/myrocket-location-ios/master/dist/myrocket-location-ios.sgmodule
   ```

3. Download it, then toggle the module **on**.

<details>
<summary>Other apps — paste the matching URL into the module/plugin import box</summary>

| App | URL |
|-----|-----|
| Surge | `https://raw.githubusercontent.com/dhava-gautama/myrocket-location-ios/master/dist/myrocket-location-ios-surge.sgmodule` |
| Surge (saved presets) | `https://raw.githubusercontent.com/dhava-gautama/myrocket-location-ios/master/dist/myrocket-location-ios-surge-easy.sgmodule` |
| Loon | `https://raw.githubusercontent.com/dhava-gautama/myrocket-location-ios/master/dist/myrocket-location-ios.lnplugin` |
| Quantumult X | `https://raw.githubusercontent.com/dhava-gautama/myrocket-location-ios/master/dist/myrocket-location-ios.snippet` |
| Stash | `https://raw.githubusercontent.com/dhava-gautama/myrocket-location-ios/master/dist/myrocket-location-ios.stoverride` |

(Loon: Settings → Plugins. Quantumult X: Settings → Rewrites. Stash:
Overwrite → Install. Surge: Home → Modules.)
</details>

### Step 4 — Pick your location on a map

Two ways, both phone-only:

**Easy way — web picker (recommended).** You need the picker running once.
If your setup includes the one-click Cloudflare Worker picker (see the picker
section below), open its link in Safari, search an address like "Tokyo Tower",
tap the result, tap **Save target**. Done — the module picks the change up
within seconds, no reinstall.

**Manual way.** In Shadowrocket, tap the module → edit arguments → change
`latitude=…&longitude=…` to your target (find coordinates in Apple Maps by
long-pressing a spot, or Google "Tokyo Tower coordinates"). Save.

**Preset switch — Surge only.** The `…-surge-easy.sgmodule` module keeps two
spots plus a custom one in its parameter table. Open Surge → **Modules** → tap
the module → fill `latA`/`lngA` and `latB`/`lngB` once (and `customLat`/
`customLng` for spot 3), then just flip `OPTIONS` between `1`, `2`, and `3`.
Each fix drifts 3–7 m so repeated locations are never byte-identical; set
`noise` to `false` for an exact pin. Preset mode wins over the picker and any
leftover `latitude`/`longitude` argument.

### Step 5 — Apply it

1. In Shadowrocket, connect (home toggle), confirm the VPN icon shows.
2. **iOS 15–18:** toggle Location Services off and on (or just open Maps).
3. **iOS 26+ (incl. betas):** you must **reboot the phone once** after changing
   location — iOS now caches location in memory and nothing short of a reboot
   clears it. Airplane-mode toggles do *not* count.
4. Open Apple Maps. You're at your target.

### Getting a fresh spot later

Web picker → search & save → (iOS 26+: reboot) → done. No module reinstall,
ever. Manual editing works too (step 4, manual way).

---

## Troubleshooting

**Location doesn't change**

1. Re-check **Certificate Trust Settings** (step 2.3) — #1 cause.
2. Module enabled? HTTPS decrypt on? VPN connected?
3. On iOS 26+, did you actually **reboot** after changing the target?
4. Module → edit → `debug=false` → `debug=true`, connect, open the app log,
   and search for `MyRocket`. "patched N wifi / M cell" means interception and
   rewriting work and the issue is caching. Turn debug back off after.
5. Strong GPS lock (outdoors, clear sky) can beat network location. Test
   indoors over Wi-Fi.

**"MITM failed" or certificate warnings** — the certificate isn't fully
trusted (step 2.3), or the VPN killed the connection. Reinstall the module's
certificate if needed. Don't add broad wildcards like `*.apple.com`; the
module already lists the five exact hosts.

**Still stuck** — open an issue with your iPhone model, iOS version, proxy
app + version, and the log lines from debug mode.

---

## Changing location remotely: the web picker (optional but recommended)

Instead of editing coordinates by hand, host a tiny "picker" web page: search
an address, tap, save. The phone's module polls it and applies changes
automatically.

The repository ships two interchangeable backends with identical APIs:

| Backend | Needs | Best for |
|---------|-------|----------|
| **Cloudflare Worker** (`location-picker/worker.js`) | A free Cloudflare account, 5 minutes, zero CLI | Most people. Free, HTTPS included, no server |
| Node server (`location-picker/server.mjs`) | Any always-on machine (VPS, NAS, Mac mini) + Docker optional | Self-hosters |

### Cloudflare Worker (no computer skills needed, no monthly cost)

1. Create a free account at dash.cloudflare.com → **Workers & Pages →
   Create → "Hello world"** → Deploy.
2. **Edit code** → select all, delete, paste the contents of
   [`location-picker/worker.js`](location-picker/worker.js) → **Deploy**.
3. Worker → **Settings → Bindings → KV** → create a namespace and name the
   variable `CONFIG`.
4. **Settings → Variables and Secrets** → add `TOKEN` with a long random
   string (any password generator, 32+ chars).
5. Open `https://<your-worker>.workers.dev/?token=<TOKEN>` in Safari:
   search, tap, save. The module argument needs one edit (once): add
   `&configUrl=<url-encoded picker URL>` to the module arguments in step 4
   above. From then on the picker is the single source of truth.

KV free tier is plenty: one saved location is ~1 write; module fetches are
throttled to one stats write per 5 minutes.

### Node server

```sh
TOKEN=$(openssl rand -hex 24) PORT=8080 node location-picker/server.mjs
# or: cd location-picker && docker compose up -d (edit .env first)
```

Add `configUrl=https://<host>:8080/loc.json?token=<TOKEN>` (URL-encoded) to
the module arguments. Address search, save, and the same stats badge work the
same as the Worker.

---

## Privacy & scope

- The engine runs inside your proxy app on your phone. It only rewrites
  responses from Apple's location endpoints; everything else passes through.
- No telemetry. The optional picker is your own deployment on your own
  account/server.
- Network location only (Wi-Fi/cell). A strong GPS signal can override it —
  indoors is the sweet spot.
- Only use on devices you own, and respect local laws and app terms.

## Technical notes (for the curious)

Apple's `/clls/wloc` responses carry Wi-Fi and cell-tower records as protobuf.
The engine rewrites only latitude/longitude/accuracy inside those records —
including cell towers (fields 22/24) — passes every other byte through
untouched, handles four response envelope formats plus a raw-byte-scan
fallback for iOS betas, and fails open (real location instead of no location)
if anything looks wrong. The script parses on iOS 12's JavaScriptCore (no
BigInt), so old phones work too.

Upstream inspiration: [mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer)
— this is an independent clean-room implementation (AGPL-3.0).

For development (tests, building modules yourself, the response-format spec):
see [DEVELOPING.md](DEVELOPING.md).
