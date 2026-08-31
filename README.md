# MyRocket Location Spoofer

Rewrites the coordinates inside Apple's location responses so iOS reports the
spot you choose — no jailbreak, no tweaked apps. Ships as modules for
Shadowrocket, Surge, Loon, Quantumult X and Stash, all driven by one portable
script engine, plus an optional self-hosted web picker for changing the target
location without touching the module again.

Inspired by [mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer);
this is an independent, clean-room implementation (AGPL-3.0, same license).

## How it works

Apple devices resolve coarse location by asking Apple's servers: "I can see
these Wi-Fi access points and cell towers — where am I?" The response contains
coordinates for each radio. The engine sits between Apple and your device
(via the proxy app's HTTPS MITM), rewrites the coordinates inside those
responses, and lets everything else through untouched.

```
iOS locationd ──> gs-loc.apple.com /clls/wloc
                        │
                 proxy app (MITM)
                        │
                 dist/wloc.engine.js        ← ARPC / synthetic / marker / bare
                        │                      protobuf parse → patch lat/lng/hacc
                 patched response ──> iOS shows your chosen spot
```

**What gets modified** — inside each `Location` submessage only latitude
(field 1), longitude (field 2) and horizontal accuracy (field 3) are replaced,
and only when they already exist. Altitude, motion state and every unknown
field pass through byte-for-byte: the fewer deltas, the smaller the chance a
future iOS build rejects the response.

**What never leaves your device** — no telemetry, no analytics, no external
calls by the engine itself. The optional picker is a service you host.

## Requirements

- iOS 12 or newer (the engine avoids BigInt/optional-chaining on purpose)
- A proxy app: Shadowrocket, Surge, Loon, Quantumult X or Stash
- The app's HTTPS decryption enabled with a trusted root certificate

## Quick start

You never need to render anything yourself: GitHub Actions builds the module
files for you on every push.

### Option A — build with GitHub Actions (no computer needed)

1. Push this repo to GitHub. On every push to the default branch the CI
   workflow runs the test suite, renders `dist/` with your repository's own
   raw URLs, and commits the result.
2. Choose the target spot by setting three repository variables
   (**Settings → Secrets and variables → Actions → Variables**, editable from
   the GitHub mobile app):

   | Variable | Example |
   |----------|---------|
   | `MYROCKET_LAT` | `35.6764` |
   | `MYROCKET_LNG` | `139.65` |
   | `MYROCKET_HACC` | `12` |

   Then re-run the **CI** workflow (or push any commit) and the committed
   `dist/` files now contain your coordinates.
3. Take the file for your app from `dist/` and install it:

   | File | App |
   |------|-----|
   | `myrocket-location-ios.sgmodule` | Shadowrocket |
   | `myrocket-location-ios-surge.sgmodule` | Surge |
   | `myrocket-location-ios.lnplugin` | Loon |
   | `myrocket-location-ios.snippet` | Quantumult X |
   | `myrocket-location-ios.stoverride` | Stash |

4. In the app, enable the module, enable HTTPS decryption (MITM), and make
   sure these hosts are covered:

   ```
   gs-loc.apple.com
   gs-loc-cn.apple.com
   gsp-ssl.ls.apple.com
   bluedot.is.autonavi.com
   bluedot.is.autonavi.com.gds.alibabadns.com
   ```

5. Reboot the phone once after enabling (this clears locationd's cached
   results; toggling location off/on is usually not enough on iOS 26+).
   Open Apple Maps and long-press your target area to verify.

Changing the location later: update the variables in step 2 and let CI
re-render, use the picker below, or edit the module's arguments directly in
the proxy app on-device.

Releases: pushing a `v*` tag runs the release workflow, which attaches the
module files to a GitHub Release (with pinned, immutable `script-path` URLs).

### Option B — build locally

```sh
node tools/cli.mjs build all 35.6764 139.65 12
```

then install the matching file from `dist/` as in step 3 above. When building
locally for import from your own fork, set the repo used in the rendered URLs:

```sh
MYROCKET_REPO=<user>/<repo> MYROCKET_BRANCH=main node tools/cli.mjs build all
```

## Remote target via the picker (optional)

The modules accept a `configUrl` argument pointing at a `loc.json` endpoint.
The response script refreshes it inline before each patch (all five apps) and
prefers its values over the hardcoded ones; if the fetch fails, the last
cached value is used, and only then the hardcoded coordinates. A cron script
on Loon optionally keeps the cache warm.

Self-host:

```sh
TOKEN=$(openssl rand -hex 24) PORT=8080 node location-picker/server.mjs
```

- Open `http://<host>:8080/?token=<TOKEN>` for the map-free coordinate page,
  or POST to `/set` to update programmatically.
- Set the module argument `configUrl=https://<host>:8080/loc.json?token=<TOKEN>`
  (URL-encode the whole value).
- HTTPS: set `CERT` and `KEY` to a fullchain/privkey pair. Without them the
  server is plain HTTP — fine on a trusted LAN, not fine through the internet.

Docker:

```sh
cd location-picker
echo "TOKEN=$(openssl rand -hex 24)" > .env
docker compose up -d
```

## Building from source

```sh
node tools/cli.mjs build all [lat] [lng] [hacc]   # render all module files
node tools/cli.mjs test                           # engine unit tests
node tools/cli.mjs demo                           # end-to-end fixture run
node tools/cli.mjs dump <hexfile>                 # patch a captured hex dump
node test/runtime.test.mjs                        # proxy-app sandbox tests
node tools/build-dist.mjs                         # dist/wloc.engine.js only
node tools/make-fixture.mjs                       # regenerate the test fixture
```

`dist/wloc.engine.js` is generated: engine (`core/wloc.mjs`) plus host adapter
(`core/runtime.js`) concatenated and export-stripped by `tools/build-dist.mjs`.
It parses on iOS 12 JavaScriptCore: no BigInt, no optional chaining, 64-bit
varints handled as 32-bit pairs.

## Response framing support

The engine tries, in order:

1. **ARPC envelope** — real Apple responses (version + pascal strings +
   function id + payload); re-serialized in place after patching.
2. **Synthetic framing** — responses previously produced by this engine
   (8-byte prefix + uint16 length), so re-patching is idempotent.
3. **Marker framing** — `00 00 00 01 00 00` + uint16 length with preserved
   surrounding bytes.
4. **Bare protobuf** — a naked AppleWLoc message.
5. **Raw byte scan** — none of the above matched: slide over the buffer and
   patch the first offset that parses as a patchable AppleWLoc message,
   re-framed as a synthetic response. This is the safety net when Apple
   changes envelope details in a beta.

If nothing patches, the original response is passed through (fail-open), so a
format change degrades to "real location" instead of "no location".

## Project layout

```
core/wloc.mjs            engine: framing, protobuf, patching (ES module)
core/runtime.js          proxy-app adapter ($request/$response/$done mapping)
modules/*.template       module templates with {{REPO}}/{{BRANCH}}/{{LATITUDE}} placeholders
tools/build-dist.mjs     engine+adapter -> dist/wloc.engine.js
tools/cli.mjs            build / test / demo / dump
tools/make-fixture.mjs   regenerate test/fixtures/arpc-response.hex
test/wloc.test.mjs       engine unit + integration tests (no framework)
test/runtime.test.mjs    sandbox tests: SR bytes, Loon/QX base64, cron, config
location-picker/         optional self-hosted target picker (Node, no deps)
dist/                    generated modules + engine (committed; modules fetch it from GitHub)
```

## Notes and limits

- Network-based location only. With a strong GPS lock the OS may prefer real
  GNSS; indoor/Wi-Fi positioning shows the spoof most reliably.
- Accuracy field is replaced with the configured value; altitude and motion
  fields are never touched.
- On iOS 26+ a reboot is required after changing targets; on iOS 15–18,
  toggling Location Services usually suffices.
- Only for devices you own. Respect the laws and terms of service where you
  use it.

## License

AGPL-3.0. Engine, tests and docs in this repository are original work
inspired by the upstream project's publicly documented behavior.
