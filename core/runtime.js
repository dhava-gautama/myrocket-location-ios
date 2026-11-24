/**
 * MyRocket Location Spoofer — proxy-app runtime adapter.
 *
 * Proxy apps expose slightly different script APIs. This adapter maps each
 * shape onto the shared engine (core/wloc.mjs):
 *
 *   Shadowrocket / Surge / Stash : $response.bodyBytes + $done({ body })
 *   Loon / Quantumult X          : $response.body as base64/latin1 string + $done({ body })
 *   Loon cron                    : no request context; refresh remote config
 *
 * tools/build-dist.mjs concatenates engine + adapter into dist/wloc.engine.js.
 */

/* ------------------------------------------------------------------ *
 * Base64 helpers (Loon and Quantumult X deliver binary bodies as text)
 * ------------------------------------------------------------------ */

var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(text) {
  var lookup = {};
  for (var n = 0; n < B64_ALPHABET.length; n += 1) lookup[B64_ALPHABET.charAt(n)] = n;
  var clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
  var padding = 0;
  if (clean.charAt(clean.length - 1) === "=") padding += 1;
  if (clean.charAt(clean.length - 1) === "=" && clean.charAt(clean.length - 2) === "=") padding += 1;
  var outLength = Math.floor((clean.length / 4) * 3) - padding;
  var out = new Uint8Array(outLength > 0 ? outLength : 0);
  var pos = 0;
  for (var j = 0; j + 3 < clean.length + 1; j += 4) {
    if (j + 4 > clean.length) break;
    var e1 = lookup[clean.charAt(j)];
    var e2 = lookup[clean.charAt(j + 1)];
    var e3 = clean.charAt(j + 2) === "=" ? 0 : lookup[clean.charAt(j + 2)];
    var e4 = clean.charAt(j + 3) === "=" ? 0 : lookup[clean.charAt(j + 3)];
    var t = (e1 << 18) | (e2 << 12) | (e3 << 6) | e4;
    out[pos] = (t >> 16) & 0xff;
    pos += 1;
    if (clean.charAt(j + 2) !== "=") {
      out[pos] = (t >> 8) & 0xff;
      pos += 1;
    }
    if (clean.charAt(j + 3) !== "=") {
      out[pos] = t & 0xff;
      pos += 1;
    }
  }
  return out;
}

function bytesToBase64(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    var t = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET.charAt((t >> 18) & 0x3f);
    out += B64_ALPHABET.charAt((t >> 12) & 0x3f);
    out += i + 1 < bytes.length ? B64_ALPHABET.charAt((t >> 6) & 0x3f) : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET.charAt(t & 0x3f) : "=";
  }
  return out;
}

function latin1StringToBytes(text) {
  var out = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/* ------------------------------------------------------------------ *
 * Host plumbing
 * ------------------------------------------------------------------ */

function runtimeName() {
  if (typeof $environment !== "undefined" && $environment && $environment.product) {
    return String($environment.product);
  }
  if (typeof $loon !== "undefined") return "Loon";
  if (typeof $task !== "undefined") return "QX";
  return "Unknown";
}

function log(message) {
  if (typeof console !== "undefined" && console.log) {
    console.log("MyRocket[" + runtimeName() + "] " + message);
  }
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  var lower = String(name).toLowerCase();
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && String(key).toLowerCase() === lower) {
      return headers[key];
    }
  }
  return undefined;
}

function setHeader(headers, name, value) {
  var out = {};
  var key;
  headers = headers || {};
  for (key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key)) out[key] = headers[key];
  }
  var replaced = false;
  for (var existing in out) {
    if (Object.prototype.hasOwnProperty.call(out, existing) && String(existing).toLowerCase() === String(name).toLowerCase()) {
      out[existing] = value;
      replaced = true;
      break;
    }
  }
  if (!replaced) out[name] = value;
  return out;
}

/**
 * Response body -> Uint8Array, whatever shape the host app hands us.
 * Strings may be true base64 (Loon/QX) or latin1 binary (Shadowrocket);
 * base64 never contains control bytes, binary protobuf almost always does.
 */
function looksLikeBase64Text(text) {
  if (text.length < 4 || text.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function responseToBytes(response) {
  var body = response && (response.bodyBytes !== undefined ? response.bodyBytes : response.body);
  if (body === null || body === undefined) return null;
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") {
    if (looksLikeBase64Text(body)) return base64ToBytes(body);
    return latin1StringToBytes(body); // raw binary delivered as a JS string
  }
  return null;
}

/** Uint8Array -> the body shape expected by the current host app. */
function packResponseBody(bytes, response) {
  var wantsString = response && response.bodyBytes === undefined && typeof response.body === "string";
  if (wantsString) return bytesToBase64(bytes);
  return bytes;
}

/** Force `Accept-Encoding: identity` so bodies arrive uncompressed. */
function handlePrepare(request) {
  var headers = setHeader((request && request.headers) || {}, "Accept-Encoding", "identity");
  $done({ headers: headers });
}

/**
 * Read + merge config: $argument string, optional cached remote config
 * (written by the cron entry or an earlier response pass), then
 * engine-side normalization.
 *
 * Returns cache metadata so callers can decide whether a remote refresh is
 * needed and fall back to stale data when the fetch fails.
 */
function applyRemoteData(args, data) {
  if (data && data.latitude !== undefined) args.latitude = data.latitude;
  if (data && data.longitude !== undefined) args.longitude = data.longitude;
  if (data && data.horizontalAccuracy !== undefined) args.horizontalAccuracy = data.horizontalAccuracy;
}

function collectConfig(argument) {
  var args = {};
  if (typeof argument === "string" && argument) {
    args = parseArgumentString(argument);
  } else if (argument && typeof argument === "object") {
    for (var key in argument) {
      if (Object.prototype.hasOwnProperty.call(argument, key)) args[key] = argument[key];
    }
  }

  var cacheUrl = resolveConfigUrl(args);
  var cacheEntry = null;
  var cacheFresh = false;
  if (cacheUrl && typeof $persistentStore !== "undefined" && $persistentStore.read) {
    try {
      var raw = $persistentStore.read("myrocket_remote_cfg");
      if (raw) {
        var entry = JSON.parse(raw);
        if (entry && entry.url === cacheUrl && entry.data) {
          cacheEntry = entry;
          cacheFresh = typeof entry.ts === "number" && Date.now() - entry.ts < 300000;
        }
      }
    } catch (err) {
      // ignore malformed cache
    }
  }
  // Stale entries are still applied: a dead picker must degrade to the last
  // known target (or the hardcoded one), never to "no location".
  if (cacheEntry) {
    applyRemoteData(args, cacheEntry.data);
  }

  // Preset mode ("easy" module) owns the target outright: the OPTIONS switch
  // must not lose to a stale picker cache or to leftover latitude/longitude
  // arguments. Without an OPTIONS key this is a no-op.
  var preset = resolvePresetTarget(args);
  if (preset) {
    args.latitude = preset.latitude;
    args.longitude = preset.longitude;
    args.preset = preset.preset;
    args.presetNoiseMeters = preset.noiseMeters;
    cacheUrl = "";
    cacheEntry = null;
    cacheFresh = true;
  }

  return {
    args: args,
    cacheUrl: cacheUrl,
    cacheEntry: cacheEntry,
    cacheFresh: cacheFresh,
    config: {
      enabled: args.enabled,
      failOpen: args.failOpen,
      debug: parseBoolean(args.debug, false),
      latitude: args.latitude,
      longitude: args.longitude,
      horizontalAccuracy: args.horizontalAccuracy,
    },
  };
}

/**
 * Rewrite the location records in a /clls/wloc response.
 * Fail-open: any engine or framing error passes the original body through.
 *
 * When a remote config (picker) URL is configured, refresh it inline with a
 * stale-cache fallback instead of relying on a cron-only refresh.
 */
function fetchRemoteConfig(url, onSuccess, onFailure) {
  if (typeof $httpClient === "undefined" || !$httpClient.get) {
    onFailure("no http client");
    return;
  }
  $httpClient.get({ url: url, timeout: 8000 }, function (error, response, body) {
    if (error || !body) {
      onFailure(error || "empty body");
      return;
    }
    try {
      var data = JSON.parse(body);
      if (!data) {
        onFailure("invalid json");
        return;
      }
      onSuccess(data);
    } catch (err) {
      onFailure("invalid json");
    }
  });
}

function cacheRemoteConfig(url, data) {
  if (typeof $persistentStore === "undefined" || !$persistentStore.write) return;
  try {
    $persistentStore.write(
      "myrocket_remote_cfg",
      JSON.stringify({ url: url, data: data, ts: Date.now() }),
    );
  } catch (err) {
    // storage failures must never break spoofing
  }
}

function patchAndDone(args, response) {
  var config = {
    enabled: args.enabled,
    failOpen: args.failOpen,
    debug: parseBoolean(args.debug, false),
    latitude: args.latitude,
    longitude: args.longitude,
    horizontalAccuracy: args.horizontalAccuracy,
  };
  var bytes = responseToBytes(response);
  if (!bytes || bytes.length < 2) {
    if (config.debug) log("no binary body; passing through");
    $done({});
    return;
  }
  var started = Date.now();
  try {
    var result = spoofWlocResponse(bytes, config);
    log(
      "patched " + result.wifiCount + " wifi / " + result.cellCount + " cell via " + result.kind +
        " in " + (Date.now() - started) + "ms",
    );
    $done({ body: packResponseBody(result.response, response) });
  } catch (err) {
    if (config.debug) log("patch failed (" + err.message + "); failing open");
    $done({});
  }
}

function handleResponse(request, response) {
  var collected = collectConfig(request && request.argument !== undefined ? request.argument : $argument);
  var args = collected.args;
  var config = collected.config;

  if (config.debug && args.preset) {
    log(
      "preset " + args.preset + " -> " + config.latitude.toFixed(6) + "," +
        config.longitude.toFixed(6) + " (" + Number(args.presetNoiseMeters || 0).toFixed(1) + " m drift)",
    );
  }

  if (!parseBoolean(args.enabled, true)) {
    log("disabled by argument; passing through");
    $done({});
    return;
  }

  var bytes = responseToBytes(response);
  if (!bytes || bytes.length < 2) {
    if (config.debug) log("no binary body; passing through");
    $done({});
    return;
  }

  // Refresh the remote config inline (all five apps), then patch. On fetch
  // failure, collectConfig already applied the stale cache or hardcoded
  // coordinates, so spoofing degrades gracefully instead of dying.
  if (collected.cacheUrl && !collected.cacheFresh) {
    if (config.debug) log("fetching remote config " + collected.cacheUrl);
    fetchRemoteConfig(
      collected.cacheUrl,
      function (data) {
        var next = {};
        for (var key in args) {
          if (Object.prototype.hasOwnProperty.call(args, key)) next[key] = args[key];
        }
        applyRemoteData(next, data);
        cacheRemoteConfig(collected.cacheUrl, data);
        patchAndDone(next, response);
      },
      function (reason) {
        if (config.debug) log("remote config fetch failed (" + reason + "); using cached/hardcoded target");
        patchAndDone(args, response);
      },
    );
    return;
  }

  patchAndDone(args, response);
}

/**
 * Cron entry (Loon): opportunistically refresh the cached remote config so
 * response passes usually hit a warm cache. Response passes also refresh
 * inline, so this is an optimization, not a requirement.
 */
function handleCron(argument) {
  var args = parseArgumentString(typeof argument === "string" ? argument : "");
  var configUrl = resolveConfigUrl(args);
  var debug = parseBoolean(args.debug, false);

  if (!configUrl) {
    if (debug) log("cron: no configUrl; nothing to do");
    $done({});
    return;
  }

  fetchRemoteConfig(
    configUrl,
    function (data) {
      cacheRemoteConfig(configUrl, data);
      log("cron: cached remote config " + data.latitude + "," + data.longitude);
      $done({});
    },
    function (reason) {
      if (debug) log("cron: fetch failed (" + reason + ")");
      $done({});
    },
  );
}

/* ------------------------------------------------------------------ *
 * Entry dispatch (engine is injected above this file by the build)
 * ------------------------------------------------------------------ */

var request = typeof $request !== "undefined" ? $request : null;
var response = typeof $response !== "undefined" ? $response : null;
var argument = typeof $argument !== "undefined" ? $argument : null;

if (response) {
  // http-response script (Shadowrocket/Surge/Loon/QX/Stash)
  handleResponse(request, response);
} else if (request) {
  // http-request script: prepare pass that forces uncompressed bodies (Loon)
  handlePrepare(request);
} else if (typeof $done === "function") {
  // cron / maintenance entry
  if (typeof $httpClient !== "undefined" && argument) {
    handleCron(argument);
  } else {
    $done({});
  }
}
