/**
 * MyRocket Location Spoofer — core engine.
 *
 * Rewrites the WiFi / cell-tower location records inside Apple's /clls/wloc
 * response bodies so that iOS locationd reports a chosen coordinate.
 *
 * Wire layers handled here:
 *   1. ARPC envelope (version + pascal strings + function id + payload length)
 *   2. Synthetic response framing (8-byte prefix + uint16 length + payload)
 *   3. Marker framing (best-effort fallback: 6-byte marker + uint16 length)
 *   4. Bare AppleWLoc protobuf, plus a raw byte-scan rescue path
 *
 * Inside each Location submessage only latitude (1), longitude (2) and
 * horizontalAccuracy (3) are replaced when they already exist; every other
 * byte is passed through untouched (minimal-rewrite principle).
 *
 * Portability rules for this file (it ships inside iOS proxy apps):
 *   - no BigInt, no optional chaining, no nullish coalescing
 *   - 64-bit varints are handled as { lo, hi } 32-bit pairs
 *   - must parse identically on iOS 12 JavaScriptCore and modern Node
 */

export var DEFAULT_CONFIG = {
  enabled: true,
  failOpen: true,
  debug: false,
  latitude: 37.3349,
  longitude: -122.00902,
  horizontalAccuracy: 39,
};

/** Synthetic response prefix emitted when we answer with our own payload. */
var SYNTHETIC_PREFIX = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);

/** Marker bytes that precede the payload length inside some real responses. */
var WLOC_MARKER = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);

/** Root-level fields that carry cell-tower records. */
var CELL_ROOT_FIELDS = { 22: true, 24: true };

var TWO_POW_32 = 4294967296;

/* ------------------------------------------------------------------ *
 * Byte helpers
 * ------------------------------------------------------------------ */

export function concatBytes(parts) {
  var total = 0;
  for (var i = 0; i < parts.length; i += 1) total += parts[i].length;
  var out = new Uint8Array(total);
  var offset = 0;
  for (var j = 0; j < parts.length; j += 1) {
    out.set(parts[j], offset);
    offset += parts[j].length;
  }
  return out;
}

export function readUInt16BE(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

export function readUInt32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

export function writeUInt16BE(value) {
  var out = new Uint8Array(2);
  out[0] = (value >> 8) & 0xff;
  out[1] = value & 0xff;
  return out;
}

export function writeUInt32BE(value) {
  var out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

export function indexOfBytes(haystack, needle, from) {
  var start = from || 0;
  if (!needle || needle.length === 0) return -1;
  for (var i = start; i <= haystack.length - needle.length; i += 1) {
    var ok = true;
    for (var j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

export function bytesStartsWith(bytes, prefix, offset) {
  var at = offset || 0;
  if (bytes.length - at < prefix.length) return false;
  for (var i = 0; i < prefix.length; i += 1) {
    if (bytes[at + i] !== prefix[i]) return false;
  }
  return true;
}

export function bytesToHex(bytes, limit) {
  if (!bytes) return "<none>";
  var max = Math.min(bytes.length, limit || 32);
  var out = "";
  for (var i = 0; i < max; i += 1) out += ("0" + bytes[i].toString(16)).slice(-2);
  return out;
}

export function binaryStringToBytes(value) {
  var out = new Uint8Array(value.length);
  for (var i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
  return out;
}

export function bytesToBinaryString(bytes) {
  var out = "";
  var chunk = 0x8000;
  for (var start = 0; start < bytes.length; start += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(start, Math.min(start + chunk, bytes.length)));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Unsigned 64-bit arithmetic as { lo, hi } 32-bit pairs
 * ------------------------------------------------------------------ */

/** Signed Number (|v| < 2^53) -> two's-complement 64-bit pair. */
export function numberToU64Pair(value) {
  var num = Math.floor(Number(value));
  if (!isFinite(num)) throw new Error("value is not a finite number: " + value);
  var negative = num < 0;
  var abs = Math.abs(num);
  var pair = { lo: (abs % TWO_POW_32) >>> 0, hi: Math.floor(abs / TWO_POW_32) >>> 0 };
  if (negative) pair = negateU64(pair);
  return pair;
}

/** Two's-complement negation modulo 2^64. */
export function negateU64(pair) {
  if (pair.lo === 0) {
    return { lo: 0, hi: (~pair.hi + 1) >>> 0 };
  }
  return { lo: (~pair.lo + 1) >>> 0, hi: ~pair.hi >>> 0 };
}

/** 64-bit pair -> signed Number (exact while |v| < 2^53, else NaN). */
export function u64PairToNumber(pair) {
  if (pair.hi >>> 31) {
    var mag = negateU64(pair);
    var magnitude = mag.hi * TWO_POW_32 + mag.lo;
    return magnitude <= 9007199254740991 ? -magnitude : NaN;
  }
  var value = pair.hi * TWO_POW_32 + pair.lo;
  return value <= 9007199254740991 ? value : NaN;
}

/** Decode an unsigned varint. Returns { value: {lo, hi}, length }. */
export function decodeVarint(bytes, offset) {
  var lo = 0;
  var hi = 0;
  var shift = 0;
  var length = 0;
  for (;;) {
    if (offset + length >= bytes.length) throw new Error("varint exceeds buffer");
    var byte = bytes[offset + length];
    length += 1;
    var bits = byte & 0x7f;
    if (shift < 32) {
      lo = (lo | (bits << shift)) >>> 0;
      if (shift > 25) hi = (hi | (bits >>> (32 - shift))) >>> 0;
    } else {
      hi = (hi | (bits << (shift - 32))) >>> 0;
    }
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (length > 10) throw new Error("varint too long");
  }
  return { value: { lo: lo, hi: hi }, length: length };
}

/**
 * Encode a varint. Accepts a non-negative Number (< 2^53) or an unsigned
 * 64-bit { lo, hi } pair (e.g. a two's-complement value from numberToU64Pair).
 */
export function encodeVarint(value) {
  var lo;
  var hi;
  if (value && typeof value === "object") {
    lo = value.lo >>> 0;
    hi = value.hi >>> 0;
  } else {
    var num = Math.floor(Number(value));
    if (!(num >= 0)) throw new Error("unsigned varint needs a non-negative value");
    lo = (num % TWO_POW_32) >>> 0;
    hi = Math.floor(num / TWO_POW_32) >>> 0;
  }
  var out = [];
  for (;;) {
    var byte = lo & 0x7f;
    var nextLo = ((lo >>> 7) | (hi << 25)) >>> 0;
    var nextHi = hi >>> 7;
    lo = nextLo;
    hi = nextHi;
    if (lo === 0 && hi === 0) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return new Uint8Array(out);
}

function encodeKey(fieldNumber, wireType) {
  return encodeVarint(fieldNumber * 8 + wireType);
}

/** Build a varint (wire type 0) field. Signed values wrap as protobuf int64. */
export function makeVarintField(fieldNumber, signedValue) {
  var pair = numberToU64Pair(signedValue);
  return concatBytes([encodeKey(fieldNumber, 0), encodeVarint(pair)]);
}

/** Build a length-delimited (wire type 2) field. */
export function makeLengthDelimitedField(fieldNumber, payload) {
  return concatBytes([encodeKey(fieldNumber, 2), encodeVarint(payload.length), payload]);
}

/**
 * Parse every field of a protobuf message. Each entry keeps its raw bytes so
 * untouched fields can be re-emitted verbatim (bit-for-bit pass-through).
 */
export function parseFields(bytes) {
  var fields = [];
  var offset = 0;
  while (offset < bytes.length) {
    var key = decodeVarint(bytes, offset);
    var keyStart = offset;
    offset += key.length;
    // (hi << 32) >> 3 == hi * 2^29; field numbers above 2^29 are unrealistic.
    var fieldNumber = (key.value.lo >> 3) + key.value.hi * 536870912;
    var wireType = key.value.lo & 7;
    if (fieldNumber <= 0) throw new Error("invalid protobuf field number");

    var valueStart = offset;
    var valueEnd = offset;
    if (wireType === 0) {
      var v = decodeVarint(bytes, offset);
      valueEnd = offset + v.length;
    } else if (wireType === 1) {
      valueEnd = offset + 8;
    } else if (wireType === 2) {
      var len = decodeVarint(bytes, offset);
      valueStart = offset + len.length; // skip the length prefix itself
      valueEnd = valueStart + len.value.lo; // lengths beyond 4 GB impossible here
    } else if (wireType === 5) {
      valueEnd = offset + 4;
    } else {
      throw new Error("unsupported protobuf wire type " + wireType);
    }
    if (valueEnd > bytes.length) throw new Error("protobuf field exceeds buffer");

    fields.push({
      fieldNumber: fieldNumber,
      wireType: wireType,
      keyStart: keyStart,
      valueStart: valueStart,
      valueEnd: valueEnd,
      end: valueEnd,
      raw: bytes.slice(keyStart, valueEnd),
      valueBytes: bytes.slice(valueStart, valueEnd),
    });
    offset = valueEnd;
  }
  return fields;
}

function firstFieldByNumber(fields, fieldNumber) {
  for (var i = 0; i < fields.length; i += 1) {
    if (fields[i].fieldNumber === fieldNumber) return fields[i];
  }
  return null;
}

/** Heuristic: could these bytes be an AppleWLoc protobuf message? */
function looksLikeWlocPayload(bytes) {
  if (!bytes || bytes.length === 0) return false;
  var tag = bytes[0];
  var fieldNumber = tag >> 3;
  var wireType = tag & 0x7;
  return fieldNumber > 0 && (wireType === 0 || wireType === 2);
}

function tryParseFields(bytes) {
  try {
    if (!bytes || bytes.length === 0) return null;
    var fields = parseFields(bytes);
    return fields.length > 0 ? fields : null;
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Coordinates
 * ------------------------------------------------------------------ */

/**
 * Convert a decimal coordinate to the on-wire int64 (degrees * 1e8).
 * Parses the decimal text form so values like 37.3349 or -122.00902 convert
 * exactly, without float64 drift. Result is exact while |v| < 2^53.
 */
export function coordinateToScaledInt(value) {
  var num = Number(value);
  if (!isFinite(num)) throw new Error("coordinate is not a finite number: " + value);
  var text = typeof value === "string" ? value.trim() : String(num);
  var match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  var scaled;
  if (match) {
    var intPart = Number(match[2] || "0");
    var frac = (match[3] || "").slice(0, 8);
    while (frac.length < 8) frac += "0";
    scaled = intPart * 100000000 + Number(frac || "0");
    if (match[1] === "-") scaled = -scaled;
  } else {
    scaled = Math.round(num * 100000000);
  }
  if (Math.abs(scaled) > 180 * 100000000 + 1) {
    throw new Error("coordinate out of range: " + value);
  }
  return scaled;
}

/** Reverse of coordinateToScaledInt, for tests and logging. */
export function scaledIntToCoordinate(scaled) {
  var value = Number(scaled);
  var negative = value < 0;
  var abs = Math.abs(value);
  var intPart = Math.floor(abs / 100000000);
  var frac = String(abs - intPart * 100000000);
  while (frac.length < 8) frac = "0" + frac;
  return (negative ? "-" : "") + intPart + "." + frac;
}

/* ------------------------------------------------------------------ *
 * ARPC envelope (used by both requests and real responses)
 * ------------------------------------------------------------------ */

function readPascalString(bytes, state) {
  var length = readUInt16BE(bytes, state.offset);
  state.offset += 2;
  if (state.offset + length > bytes.length) throw new Error("ARPC string exceeds buffer");
  var out = "";
  for (var i = 0; i < length; i += 1) out += String.fromCharCode(bytes[state.offset + i]);
  state.offset += length;
  return out;
}

function writePascalString(value) {
  var out = new Uint8Array(value.length);
  for (var i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
  return concatBytes([writeUInt16BE(out.length), out]);
}

export function parseArpcEnvelope(bytes) {
  var state = { offset: 0 };
  var version = readUInt16BE(bytes, state.offset);
  state.offset += 2;
  var locale = readPascalString(bytes, state);
  var appIdentifier = readPascalString(bytes, state);
  var osVersion = readPascalString(bytes, state);
  var functionId = readUInt32BE(bytes, state.offset);
  state.offset += 4;
  var payloadLength = readUInt32BE(bytes, state.offset);
  state.offset += 4;
  if (state.offset + payloadLength > bytes.length) throw new Error("ARPC payload exceeds buffer");
  return {
    version: version,
    locale: locale,
    appIdentifier: appIdentifier,
    osVersion: osVersion,
    functionId: functionId,
    payload: bytes.slice(state.offset, state.offset + payloadLength),
  };
}

export function serializeArpcEnvelope(envelope, payload) {
  var body = payload || envelope.payload;
  return concatBytes([
    writeUInt16BE(envelope.version),
    writePascalString(envelope.locale),
    writePascalString(envelope.appIdentifier),
    writePascalString(envelope.osVersion),
    writeUInt32BE(envelope.functionId),
    writeUInt32BE(body.length),
    body,
  ]);
}

/* ------------------------------------------------------------------ *
 * Payload extraction
 * ------------------------------------------------------------------ */

/** Wrap a patched (or synthesized) payload in the synthetic response framing. */
export function buildSyntheticResponse(payload) {
  return concatBytes([SYNTHETIC_PREFIX, writeUInt16BE(payload.length), payload]);
}

/**
 * Extract the AppleWLoc protobuf payload from a response body.
 * Returns { kind, payload, ...rebuild context } or throws.
 */
export function extractWlocPayload(bytes) {
  if (!bytes || bytes.length < 2) throw new Error("response body too short");

  // Shape 1: synthetic framing produced by our own responses.
  if (bytes.length >= 10 && bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[6] === 0x00 && bytes[7] === 0x00) {
    var syntheticLength = readUInt16BE(bytes, 8);
    var syntheticOffset = 10;
    if (syntheticLength > 0 && syntheticOffset + syntheticLength <= bytes.length) {
      var syntheticPayload = bytes.slice(syntheticOffset, syntheticOffset + syntheticLength);
      if (tryParseFields(syntheticPayload)) {
        return { kind: "synthetic", payload: syntheticPayload, prefix: bytes.slice(0, 8) };
      }
    }
  }

  // Shape 2: full ARPC envelope.
  try {
    var envelope = parseArpcEnvelope(bytes);
    if (envelope.payload.length > 0 && tryParseFields(envelope.payload)) {
      return { kind: "arpc", payload: envelope.payload, envelope: envelope };
    }
  } catch (err) {
    // fall through
  }

  // Shape 3: marker + uint16 length framing (keeps surrounding bytes).
  var markerIndex = indexOfBytes(bytes, WLOC_MARKER);
  if (markerIndex >= 0) {
    var lenOffset = markerIndex + WLOC_MARKER.length;
    if (lenOffset + 2 <= bytes.length) {
      var markerLength = readUInt16BE(bytes, lenOffset);
      var markerPayloadOffset = lenOffset + 2;
      if (markerLength > 0 && markerPayloadOffset + markerLength <= bytes.length) {
        var markerPayload = bytes.slice(markerPayloadOffset, markerPayloadOffset + markerLength);
        if (tryParseFields(markerPayload)) {
          return {
            kind: "marker",
            payload: markerPayload,
            prefix: bytes.slice(0, markerIndex),
            suffix: bytes.slice(markerPayloadOffset + markerLength),
          };
        }
      }
    }
  }

  // Shape 4: bare protobuf payload.
  if (looksLikeWlocPayload(bytes) && tryParseFields(bytes)) {
    return { kind: "bare", payload: bytes };
  }

  throw new Error("no recognizable WLoc framing in response body");
}

/* ------------------------------------------------------------------ *
 * Patching
 * ------------------------------------------------------------------ */

function signedFieldValue(field) {
  if (!field || field.wireType !== 0) return NaN;
  var decoded = decodeVarint(field.valueBytes, 0);
  return u64PairToNumber(decoded.value);
}

/** Replace lat/lng/hacc inside a Location submessage; pass everything else through. */
function patchLocationSubmessage(payload, config) {
  var fields;
  try {
    fields = payload.length ? parseFields(payload) : [];
  } catch (err) {
    return payload;
  }
  var hasLat = false;
  var hasLng = false;
  for (var i = 0; i < fields.length; i += 1) {
    if (fields[i].fieldNumber === 1 && fields[i].wireType === 0) hasLat = true;
    if (fields[i].fieldNumber === 2 && fields[i].wireType === 0) hasLng = true;
  }
  // No usable coordinate pair -> leave the submessage untouched.
  if (!hasLat || !hasLng) return payload;

  var parts = [];
  for (var j = 0; j < fields.length; j += 1) {
    var field = fields[j];
    if (field.fieldNumber === 1 && field.wireType === 0) {
      parts.push(makeVarintField(1, coordinateToScaledInt(config.latitude)));
    } else if (field.fieldNumber === 2 && field.wireType === 0) {
      parts.push(makeVarintField(2, coordinateToScaledInt(config.longitude)));
    } else if (field.fieldNumber === 3 && field.wireType === 0) {
      parts.push(makeVarintField(3, config.horizontalAccuracy));
    } else {
      parts.push(field.raw);
    }
  }
  return concatBytes(parts);
}

function patchWifiDevice(payload, config) {
  var fields = parseFields(payload);
  var parts = [];
  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    if (field.fieldNumber === 2 && field.wireType === 2) {
      parts.push(makeLengthDelimitedField(2, patchLocationSubmessage(field.valueBytes, config)));
    } else {
      parts.push(field.raw);
    }
  }
  return concatBytes(parts);
}

function patchCellTower(payload, config) {
  var fields = parseFields(payload);
  var parts = [];
  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    if (field.fieldNumber === 5 && field.wireType === 2) {
      parts.push(makeLengthDelimitedField(5, patchLocationSubmessage(field.valueBytes, config)));
    } else {
      parts.push(field.raw);
    }
  }
  return concatBytes(parts);
}

/** Patch the AppleWLoc root message; returns { payload, wifiCount, cellCount }. */
export function patchWlocRoot(payload, config) {
  var fields = parseFields(payload);
  var parts = [];
  var wifiCount = 0;
  var cellCount = 0;
  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    if (field.fieldNumber === 2 && field.wireType === 2) {
      parts.push(makeLengthDelimitedField(2, patchWifiDevice(field.valueBytes, config)));
      wifiCount += 1;
    } else if (CELL_ROOT_FIELDS[field.fieldNumber] === true && field.wireType === 2) {
      parts.push(makeLengthDelimitedField(field.fieldNumber, patchCellTower(field.valueBytes, config)));
      cellCount += 1;
    } else {
      parts.push(field.raw);
    }
  }
  return { payload: concatBytes(parts), wifiCount: wifiCount, cellCount: cellCount };
}

/* ------------------------------------------------------------------ *
 * Raw byte-scan rescue path
 * ------------------------------------------------------------------ */

/**
 * Last resort when no known framing matches: slide over the buffer and patch
 * the first offset that parses as a patchable AppleWLoc message. The result is
 * re-framed as a synthetic response.
 */
export function scanPatchWloc(bytes, config) {
  if (!bytes || bytes.length < 8) throw new Error("body too short for raw scan");
  var offsets = [];
  var frameLimit = Math.min(96, Math.max(0, bytes.length - 10));
  for (var i = 0; i <= frameLimit; i += 2) offsets.push(i);
  var rawLimit = Math.min(256, Math.max(0, bytes.length - 4));
  for (var j = 0; j <= rawLimit; j += 1) {
    if (offsets.indexOf(j) < 0) offsets.push(j);
  }
  var errors = [];
  for (var k = 0; k < offsets.length; k += 1) {
    var offset = offsets[k];
    var slice = bytes.slice(offset);
    if (!looksLikeWlocPayload(slice)) continue;
    try {
      var patched = patchWlocRoot(slice, config);
      if (patched.wifiCount > 0 || patched.cellCount > 0) {
        return {
          response: buildSyntheticResponse(patched.payload),
          payload: patched.payload,
          wifiCount: patched.wifiCount,
          cellCount: patched.cellCount,
          kind: "raw",
          offset: offset,
        };
      }
    } catch (err) {
      if (errors.length < 6) errors.push("@" + offset + ": " + err.message);
    }
  }
  throw new Error("raw scan found no patchable WLoc payload" + (errors.length ? "; " + errors.join(" | ") : ""));
}

/* ------------------------------------------------------------------ *
 * Config + argument parsing
 * ------------------------------------------------------------------ */

export function parseBoolean(value, defaultValue) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) return defaultValue;
  var normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return defaultValue;
}

export function normalizeConfig(input) {
  var raw = input || {};
  function pick(key, fallback) {
    var value = raw[key];
    if (value === null || value === undefined || value === "") return fallback;
    return value;
  }
  var config = {
    enabled: parseBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
    failOpen: parseBoolean(raw.failOpen, DEFAULT_CONFIG.failOpen),
    debug: parseBoolean(raw.debug, DEFAULT_CONFIG.debug),
    latitude: Number(pick("latitude", DEFAULT_CONFIG.latitude)),
    longitude: Number(pick("longitude", DEFAULT_CONFIG.longitude)),
    horizontalAccuracy: Math.trunc(Number(pick("horizontalAccuracy", DEFAULT_CONFIG.horizontalAccuracy))),
  };
  if (!isFinite(config.latitude) || config.latitude < -90 || config.latitude > 90) {
    throw new Error("invalid latitude: " + raw.latitude);
  }
  if (!isFinite(config.longitude) || config.longitude < -180 || config.longitude > 180) {
    throw new Error("invalid longitude: " + raw.longitude);
  }
  if (!isFinite(config.horizontalAccuracy) || config.horizontalAccuracy < 0) {
    throw new Error("invalid horizontalAccuracy: " + raw.horizontalAccuracy);
  }
  return config;
}

/**
 * Parse a proxy-app `argument=` string ("a=1&b=2") into an object.
 * Values are URL-decoded; valueless keys become "true". `configUrl=` is
 * captured greedily (it may contain encoded `&`), so it is split off first.
 */
export function parseArgumentString(argument) {
  var result = {};
  if (!argument || typeof argument !== "string") return result;

  var tailKeys = [
    "debug", "mode", "enabled", "latitude", "longitude", "horizontalAccuracy",
    "failOpen", "configHost", "configToken", "label",
  ];
  var configUrlKey = "configUrl=";
  var configUrlIndex = argument.indexOf(configUrlKey);
  if (configUrlIndex >= 0) {
    var tail = argument.slice(configUrlIndex + configUrlKey.length);
    var end = -1;
    for (var t = 0; t < tailKeys.length; t += 1) {
      var pos = tail.indexOf("&" + tailKeys[t] + "=");
      if (pos >= 0 && (end < 0 || pos < end)) end = pos;
    }
    var configUrlValue = end >= 0 ? tail.slice(0, end) : tail;
    try {
      result.configUrl = decodeURIComponent(configUrlValue);
    } catch (err) {
      result.configUrl = configUrlValue;
    }
    argument = argument.slice(0, configUrlIndex) + (end >= 0 ? tail.slice(end + 1) : "");
  }

  var pairs = argument.split(/[&;]/);
  for (var i = 0; i < pairs.length; i += 1) {
    var part = pairs[i];
    if (!part) continue;
    var eq = part.indexOf("=");
    var key = eq >= 0 ? part.slice(0, eq) : part;
    var value = eq >= 0 ? part.slice(eq + 1) : "true";
    try {
      result[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch (err2) {
      result[key] = value;
    }
  }
  return result;
}

/** Build a configUrl from configHost + configToken when configUrl is absent. */
export function resolveConfigUrl(args) {
  args = args || {};
  var direct = String(args.configUrl || args.cfg || args.url || "").trim();
  if (direct) return direct;
  var host = String(args.configHost || "").trim();
  var token = String(args.configToken || "").trim();
  while (host.charAt(host.length - 1) === "/") host = host.slice(0, -1);
  if (host && token) return host + "/loc.json?token=" + encodeURIComponent(token);
  return "";
}

/* ------------------------------------------------------------------ *
 * Preset mode ("easy" switch)
 *
 * A module may offer one `OPTIONS` argument instead of raw coordinates:
 * 1 / A -> preset A, 2 / B -> preset B, anything else (3, "custom") -> C.
 * Each fix is optionally drifted by a few metres so repeated fixes are not
 * byte-identical, which is what a device that never moves would look like.
 * All of this is optional: without an OPTIONS key the engine behaves exactly
 * as before and the latitude/longitude/picker paths are untouched.
 *
 * Clock skew, GPS noise and map matching all expect a target that wobbles a
 * little; a perfectly constant coordinate is the anomaly, not the drift.
 * ------------------------------------------------------------------ */

/** Metres per degree of latitude (WGS-84 mean), matching the preset math. */
var METERS_PER_DEGREE_LAT = 111320;

/** Default random drift applied in preset mode, in metres. */
export var DEFAULT_PRESET_NOISE = { min: 3, max: 7 };

/** Argument spellings accepted for each preset slot. */
var PRESET_SLOTS = {
  A: { lat: ["latA", "latitudeA", "lat_a"], lng: ["lngA", "longitudeA", "lng_a"] },
  B: { lat: ["latB", "latitudeB", "lat_b"], lng: ["lngB", "longitudeB", "lng_b"] },
  C: { lat: ["customLat", "custom_lat"], lng: ["customLng", "custom_lng"] },
};

/** Read the first parseable number among `keys`, or null. */
function readPresetNumber(args, keys) {
  for (var i = 0; i < keys.length; i += 1) {
    var raw = args[keys[i]];
    if (raw === null || raw === undefined || raw === "") continue;
    var value = Number(raw);
    if (isFinite(value)) return value;
  }
  return null;
}

/** Map the OPTIONS argument onto a preset slot ("A"/"B"/"C"), or null. */
export function readPresetSlot(args) {
  args = args || {};
  var raw = args.OPTIONS;
  if (raw === undefined) raw = args.options;
  if (raw === undefined) raw = args.option;
  if (raw === undefined) raw = args.preset;
  if (raw === undefined || raw === null) return null;

  var value = String(raw).trim().toLowerCase();
  if (!value) return null;
  if (value === "1" || value === "a" || value === "locationa" || value === "location a" || value === "location-a") {
    return "A";
  }
  if (value === "2" || value === "b" || value === "locationb" || value === "location b" || value === "location-b") {
    return "B";
  }
  return "C";
}

/**
 * Offset a coordinate by a random distance in `[minMeters, maxMeters]`.
 * `random` is injectable so tests are deterministic; it defaults to Math.random.
 * The latitude/longitude pair is clamped to valid WGS-84 bounds.
 */
export function jitterCoordinate(latitude, longitude, minMeters, maxMeters, random) {
  var rand = typeof random === "function" ? random : Math.random;
  var min = isFinite(minMeters) && minMeters > 0 ? minMeters : 0;
  var max = isFinite(maxMeters) && maxMeters > min ? maxMeters : min;
  var meters = min + rand() * (max - min);
  var angle = rand() * Math.PI * 2;
  var dLat = (meters * Math.cos(angle)) / METERS_PER_DEGREE_LAT;
  var metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((latitude * Math.PI) / 180);
  var dLng = Math.abs(metersPerDegreeLng) < 1 ? 0 : (meters * Math.sin(angle)) / metersPerDegreeLng;

  var lat = Math.max(-90, Math.min(90, latitude + dLat));
  var lng = ((((longitude + dLng) + 540) % 360) + 360) % 360 - 180;
  return { latitude: lat, longitude: lng, noiseMeters: meters };
}

/**
 * Resolve the preset target for this pass, or null when preset mode is off.
 *
 * Returns `{preset, latitude, longitude, noiseMeters, baseLatitude,
 * baseLongitude}`. `latitude`/`longitude` already include the drift, so
 * callers can drop them straight into the config. Unparseable or out-of-range
 * preset coordinates return null so a typo degrades to the normal path
 * instead of killing the script.
 */
export function resolvePresetTarget(args, random) {
  args = args || {};
  var slot = readPresetSlot(args);
  if (!slot) return null;

  var spec = PRESET_SLOTS[slot];
  var latitude = readPresetNumber(args, spec.lat);
  var longitude = readPresetNumber(args, spec.lng);
  // Preset C may fall back to plain latitude/longitude (picker-style args).
  if (slot === "C") {
    if (latitude === null) latitude = readPresetNumber(args, ["latitude"]);
    if (longitude === null) longitude = readPresetNumber(args, ["longitude"]);
  }
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  var noise = parseBoolean(args.noise, parseBoolean(args.jitter, true));
  var min = readPresetNumber(args, ["noiseMin", "noise_min", "jitterMin"]);
  var max = readPresetNumber(args, ["noiseMax", "noise_max", "jitterMax"]);
  if (min === null) min = DEFAULT_PRESET_NOISE.min;
  if (max === null) max = DEFAULT_PRESET_NOISE.max;
  if (min < 0) min = 0;
  if (max < min) max = min;

  var target = {
    preset: slot,
    latitude: latitude,
    longitude: longitude,
    baseLatitude: latitude,
    baseLongitude: longitude,
    noiseMeters: 0,
  };
  if (!noise || max === 0) return target;

  var drift = jitterCoordinate(latitude, longitude, min, max, random);
  target.latitude = drift.latitude;
  target.longitude = drift.longitude;
  target.noiseMeters = drift.noiseMeters;
  return target;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function rebuildResponse(extraction, patchedPayload) {
  if (extraction.kind === "arpc") {
    return serializeArpcEnvelope(extraction.envelope, patchedPayload);
  }
  if (extraction.kind === "marker") {
    return concatBytes([
      extraction.prefix,
      WLOC_MARKER,
      writeUInt16BE(patchedPayload.length),
      patchedPayload,
      extraction.suffix,
    ]);
  }
  if (extraction.kind === "synthetic") {
    return concatBytes([extraction.prefix, writeUInt16BE(patchedPayload.length), patchedPayload]);
  }
  return buildSyntheticResponse(patchedPayload); // bare
}

/**
 * Main entry point: take a /clls/wloc response body, return the patched body.
 * Throws when nothing could be patched (callers usually fail open).
 */
export function spoofWlocResponse(bytes, configInput) {
  var config = normalizeConfig(configInput);
  var extraction = null;
  var strictError = null;
  try {
    extraction = extractWlocPayload(bytes);
  } catch (err) {
    strictError = err;
  }

  if (extraction) {
    var patched = patchWlocRoot(extraction.payload, config);
    if (patched.wifiCount > 0 || patched.cellCount > 0) {
      return {
        response: rebuildResponse(extraction, patched.payload),
        payload: patched.payload,
        wifiCount: patched.wifiCount,
        cellCount: patched.cellCount,
        kind: extraction.kind,
      };
    }
    strictError = new Error("no patchable location fields via " + extraction.kind + " framing");
  }

  var raw = scanPatchWloc(bytes, config);
  return {
    response: raw.response,
    payload: raw.payload,
    wifiCount: raw.wifiCount,
    cellCount: raw.cellCount,
    kind: raw.kind,
    offset: raw.offset,
    strictError: strictError ? strictError.message : null,
  };
}
