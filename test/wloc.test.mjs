/**
 * Unit + integration tests for the MyRocket WLoc engine.
 * Runs on plain Node (no framework) via `node tools/cli.mjs test`.
 */

import {
  concatBytes,
  DEFAULT_PRESET_NOISE,
  coordinateToScaledInt,
  decodeVarint,
  encodeVarint,
  extractWlocPayload,
  makeLengthDelimitedField,
  makeVarintField,
  normalizeConfig,
  parseArpcEnvelope,
  parseArgumentString,
  parseFields,
  patchWlocRoot,
  readPresetSlot,
  resolveConfigUrl,
  resolvePresetTarget,
  scaledIntToCoordinate,
  serializeArpcEnvelope,
  spoofWlocResponse,
  u64PairToNumber,
  numberToU64Pair,
} from "../core/wloc.mjs";
import { bytesToHex, hexToBytes } from "./hex.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(name + (detail ? " — " + detail : ""));
  }
}

function hexEq(name, actualHex, expectedHex) {
  check(
    name,
    actualHex.replace(/\s+/g, "") === expectedHex.replace(/\s+/g, ""),
    "got " + actualHex + " want " + expectedHex,
  );
}

/* ------------------------------------------------------------------ *
 * Synthetic fixtures (built with our own encoder, then re-parsed)
 * ------------------------------------------------------------------ */

function locationMessage(lat, lng, hacc) {
  return concatBytes([
    makeVarintField(1, lat),
    makeVarintField(2, lng),
    makeVarintField(3, hacc),
  ]);
}

function wifiDevice(lat, lng, hacc, mac) {
  const fields = [makeLengthDelimitedField(2, locationMessage(lat, lng, hacc))];
  if (mac) fields.push(makeLengthDelimitedField(3, mac));
  return concatBytes(fields);
}

function buildRoot(wifiCount, cellCount) {
  const parts = [];
  for (let i = 0; i < wifiCount; i += 1) {
    parts.push(makeLengthDelimitedField(2, wifiDevice(48.8584 + i * 0.001, 2.2945 - i * 0.001, 65)));
  }
  for (let i = 0; i < cellCount; i += 1) {
    parts.push(makeLengthDelimitedField(22, concatBytes([
      makeVarintField(1, 310),
      makeLengthDelimitedField(5, locationMessage(52.52 + i * 0.002, 13.405 + i * 0.002, 85)),
    ])));
  }
  return concatBytes(parts);
}

function buildArpc(payload) {
  return serializeArpcEnvelope({
    version: 1,
    locale: "en_US",
    appIdentifier: "com.apple.locationd",
    osVersion: "17.5.1",
    functionId: 1,
    payload,
  });
}

const NEW_LAT = 35.6764;
const NEW_LNG = 139.65;

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

function testVarintRoundTrip() {
  for (const value of [0, 1, 127, 128, 300, 16384, 1224423, 2147483647]) {
    const encoded = encodeVarint(value);
    const decoded = decodeVarint(encoded, 0);
    check("varint roundtrip " + value, u64PairToNumber(decoded.value) === value && decoded.length === encoded.length);
  }
  const big = numberToU64Pair(-12200902000); // two's complement 64-bit
  const encoded = encodeVarint(big);
  // -12200902000 as uint64 is 0xFFFFFFFF_D2C69490 -> 10-byte varint.
  check("varint encodes 64-bit pair", encoded.length === 10 && encoded[9] === 0x01, bytesToHex(encoded, 0));
  const roundtrip = u64PairToNumber(decodeVarint(encoded, 0).value);
  check("varint 64-bit roundtrip", roundtrip === -12200902000, String(roundtrip));
}

function testCoordinateConversion() {
  check("coordinate 37.3349", coordinateToScaledInt(37.3349) === 3733490000, String(coordinateToScaledInt(37.3349)));
  check("coordinate -122.00902", coordinateToScaledInt(-122.00902) === -12200902000, String(coordinateToScaledInt(-122.00902)));
  check("coordinate string form", coordinateToScaledInt("35.6764") === 3567640000);
  check("roundtrip string", scaledIntToCoordinate(coordinateToScaledInt("139.65")) === "139.65000000");
  check("negative roundtrip", scaledIntToCoordinate(coordinateToScaledInt("-122.00902")) === "-122.00902000");
}

function testParseFields() {
  const message = locationMessage(3733490000, -12200902000, 39);
  const fields = parseFields(message);
  check("location submessage has 3 fields", fields.length === 3);
  check("field 1 is varint", fields[0].fieldNumber === 1 && fields[0].wireType === 0);
  check("field 2 carries signed longitude", u64PairToNumber(decodeVarint(fields[1].valueBytes, 0).value) === -12200902000);
}

function testPatchRoot() {
  const root = buildRoot(2, 1);
  const patched = patchWlocRoot(root, normalizeConfig({ latitude: NEW_LAT, longitude: NEW_LNG }));
  check("patch counts wifi", patched.wifiCount === 2);
  check("patch counts cell", patched.cellCount === 1);

  // Verify the patched coordinates inside the first wifi device.
  const wifi = parseFields(patched.payload)[0];
  const locFields = parseFields(parseFields(wifi.valueBytes)[0].valueBytes);
  const lat = u64PairToNumber(decodeVarint(locFields[0].valueBytes, 0).value);
  check("wifi latitude rewritten", lat === Math.round(NEW_LAT * 100000000), String(lat));
  const lng = u64PairToNumber(decodeVarint(locFields[1].valueBytes, 0).value);
  check("wifi longitude rewritten", lng === Math.round(NEW_LNG * 100000000), String(lng));
}

function testArpcRoundTrip() {
  const root = buildRoot(1, 1);
  const envelopeBytes = buildArpc(root);
  const envelope = parseArpcEnvelope(envelopeBytes);
  check("arpc parses", envelope.functionId === 1 && envelope.locale === "en_US");
  check("arpc payload matches", bytesToHex(envelope.payload, 0) === bytesToHex(root, 0));
  const reserialized = serializeArpcEnvelope(envelope);
  check("arpc reserializes identically", bytesToHex(reserialized, 0) === bytesToHex(envelopeBytes, 0));
}

function testExtractShapes() {
  const root = buildRoot(1, 0);

  const arpc = extractWlocPayload(buildArpc(root));
  check("extract arpc", arpc.kind === "arpc");

  const synthetic = extractWlocPayload(concatBytes([
    new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]),
    new Uint8Array([root.length >> 8, root.length & 0xff]),
    root,
  ]));
  check("extract synthetic", synthetic.kind === "synthetic");

  const marker = extractWlocPayload(concatBytes([
    new Uint8Array([0xde, 0xad]),
    new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]),
    new Uint8Array([root.length >> 8, root.length & 0xff]),
    root,
    new Uint8Array([0xca, 0xfe]),
  ]));
  check("extract marker keeps suffix", marker.kind === "marker" && marker.suffix.length === 2);

  const bare = extractWlocPayload(root);
  check("extract bare", bare.kind === "bare");
}

function testSpoofEndToEnd() {
  const config = { latitude: NEW_LAT, longitude: NEW_LNG, horizontalAccuracy: 12 };

  // ARPC input stays ARPC; marker input keeps its framing bytes.
  const arpcIn = buildArpc(buildRoot(2, 1));
  const arpcOut = spoofWlocResponse(arpcIn, config);
  check("e2e arpc kind", arpcOut.kind === "arpc" && arpcOut.wifiCount === 2 && arpcOut.cellCount === 1);
  const reread = spoofWlocResponse(arpcOut.response, config);
  check("e2e arpc stable on re-patch", reread.kind === "arpc");

  const markerIn = concatBytes([
    new Uint8Array([0x11, 0x22]),
    new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]),
    new Uint8Array([0x00, 0x40]),
    buildRoot(1, 0),
  ]);
  // Note: the hand-written 0x0040 length is wrong on purpose? No — rebuild the
  // input properly so the framing length is exact.
  const markerRoot = buildRoot(1, 0);
  const markerInExact = concatBytes([
    new Uint8Array([0x11, 0x22]),
    new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]),
    new Uint8Array([markerRoot.length >> 8, markerRoot.length & 0xff]),
    markerRoot,
  ]);
  const markerOut = spoofWlocResponse(markerInExact, config);
  check("e2e marker kind", markerOut.kind === "marker");
  check("e2e marker prefix kept", bytesToHex(markerOut.response.slice(0, 2), 0) === "1122");
  // prefix(2) + marker(6) + uint16 length; the declared length must cover the
  // patched payload exactly (patched coords are longer than the fixture's).
  const declaredLength = (markerOut.response[8] << 8) | markerOut.response[9];
  check(
    "e2e marker length rewritten",
    declaredLength === markerOut.response.length - 10,
    "declared " + declaredLength + " vs " + (markerOut.response.length - 10),
  );
  check("e2e marker wifi patched", markerOut.wifiCount === 1);

  // Garbage input must throw (caller fails open).
  let threw = false;
  try {
    spoofWlocResponse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), config);
  } catch (err) {
    threw = true;
  }
  check("garbage input throws for fail-open handling", threw);
}

function testConfigAndArgs() {
  const config = normalizeConfig({ latitude: "35.6764", longitude: "139.65", horizontalAccuracy: "7" });
  check("normalize strings", config.latitude === 35.6764 && config.horizontalAccuracy === 7);

  let threw = false;
  try {
    normalizeConfig({ latitude: "91" });
  } catch {
    threw = true;
  }
  check("rejects out-of-range latitude", threw);

  const args = parseArgumentString("mode=response&latitude=1.2&configUrl=https%3A%2F%2Fexample.test%2Floc.json%3Ftoken%3Dabc&debug=true");
  check("argument configUrl survives & splitting", args.configUrl === "https://example.test/loc.json?token=abc");
  check("argument scalars", args.latitude === "1.2" && args.debug === "true" && args.mode === "response");

  const url = resolveConfigUrl({ configHost: "https://picker.example/", configToken: "tok" });
  check("resolveConfigUrl joins host+token", url === "https://picker.example/loc.json?token=tok", url);
}

function testPresetMode() {
  check("preset off without OPTIONS", resolvePresetTarget({ latitude: "1", longitude: "2" }) === null);

  const a = resolvePresetTarget({ OPTIONS: "1", latA: "10.5", lngA: "20.25", noise: "false" });
  check("preset A exact", a && a.preset === "A" && a.latitude === 10.5 && a.longitude === 20.25 && a.noiseMeters === 0);

  const b = resolvePresetTarget({ options: "b", latB: "48.8566", lngB: "2.3522", noise: "false" });
  check("preset B via lowercase key/value", b && b.preset === "B" && b.latitude === 48.8566 && b.longitude === 2.3522);

  const c = resolvePresetTarget({ OPTIONS: "3", customLat: "-6.2", customLng: "106.8", latitude: "99", longitude: "99", noise: "false" });
  check("preset C prefers custom coords", c && c.preset === "C" && c.latitude === -6.2 && c.longitude === 106.8);

  const fallback = resolvePresetTarget({ OPTIONS: "custom", latitude: "35.6764", longitude: "139.65", noise: "false" });
  check("preset C falls back to latitude/longitude", fallback && fallback.latitude === 35.6764 && fallback.longitude === 139.65);

  check("preset rejects out-of-range coords", resolvePresetTarget({ OPTIONS: "1", latA: "95", lngA: "0" }) === null);
  check("preset rejects unparseable coords", resolvePresetTarget({ OPTIONS: "1", latA: "abc", lngA: "0" }) === null);
  check("readPresetSlot maps unknown values to C", readPresetSlot({ OPTIONS: "banana" }) === "C");

  const jittered = resolvePresetTarget({ OPTIONS: "1", latA: "-6.111412", lngA: "106.131867" }, () => 0.5);
  check(
    "preset drift stays within default 3-7 m",
    jittered.noiseMeters >= DEFAULT_PRESET_NOISE.min && jittered.noiseMeters <= DEFAULT_PRESET_NOISE.max,
    String(jittered.noiseMeters),
  );
  const dLatM = (jittered.latitude - jittered.baseLatitude) * 111320;
  const dLngM =
    (jittered.longitude - jittered.baseLongitude) * 111320 * Math.cos((jittered.baseLatitude * Math.PI) / 180);
  const distance = Math.sqrt(dLatM * dLatM + dLngM * dLngM);
  check("preset drift magnitude matches noiseMeters", Math.abs(distance - jittered.noiseMeters) < 0.01, distance + " vs " + jittered.noiseMeters);

  const again = resolvePresetTarget({ OPTIONS: "1", latA: "-6.111412", lngA: "106.131867" }, () => 0.5);
  check("preset drift is deterministic for a fixed random source", again.latitude === jittered.latitude && again.longitude === jittered.longitude);

  const wide = resolvePresetTarget({ OPTIONS: "1", latA: "-6.111412", lngA: "106.131867", noiseMin: "0", noiseMax: "100" }, () => 0.999);
  check("preset honours noiseMin/noiseMax", wide.noiseMeters > 99 && wide.noiseMeters < 100.1, String(wide.noiseMeters));

  const exact = resolvePresetTarget({ OPTIONS: "1", latA: "-6.111412", lngA: "106.131867", noise: "false" });
  check("noise=false keeps the exact target", exact.latitude === -6.111412 && exact.longitude === 106.131867 && exact.noiseMeters === 0);
}

function testMinimality() {
  // A wifi record with an extra field (field 4 = ssid) must keep it verbatim.
  const device = concatBytes([
    makeLengthDelimitedField(2, locationMessage(1.5, 2.5, 30)),
    makeLengthDelimitedField(4, hexToBytes("aabbcc")),
  ]);
  const root = makeLengthDelimitedField(2, device);
  const patched = patchWlocRoot(root, normalizeConfig({ latitude: 3.25, longitude: 4.75 }));
  const patchedDevice = parseFields(patched.payload)[0];
  const kept = parseFields(patchedDevice.valueBytes)[1];
  check("unknown sibling field preserved", kept.fieldNumber === 4 && bytesToHex(kept.valueBytes, 0) === "aabbcc");
  const loc = parseFields(parseFields(patchedDevice.valueBytes)[0].valueBytes);
  check("patched lat exact", u64PairToNumber(decodeVarint(loc[0].valueBytes, 0).value) === 325000000);
}

function testPreservesNonLocationFields() {
  // Location submessage with altitude (field 4) and unknown (field 9): only 1/2/3 change.
  const sub = concatBytes([
    makeVarintField(1, 10000000),
    makeVarintField(2, 20000000),
    makeVarintField(3, 65),
    makeVarintField(4, 12345),
    makeVarintField(9, 777),
  ]);
  const root = makeLengthDelimitedField(2, makeLengthDelimitedField(2, sub));
  const patched = patchWlocRoot(root, normalizeConfig({ latitude: 1.5, longitude: 2.5 }));
  const fields = parseFields(parseFields(parseFields(patched.payload)[0].valueBytes)[0].valueBytes);
  check("altitude (4) untouched", u64PairToNumber(decodeVarint(fields[3].valueBytes, 0).value) === 12345);
  check("unknown (9) untouched", u64PairToNumber(decodeVarint(fields[4].valueBytes, 0).value) === 777);
  check("hacc (3) rewritten", u64PairToNumber(decodeVarint(fields[2].valueBytes, 0).value) === 39);
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

export function runTests() {
  testVarintRoundTrip();
  testCoordinateConversion();
  testParseFields();
  testPatchRoot();
  testArpcRoundTrip();
  testExtractShapes();
  testSpoofEndToEnd();
  testConfigAndArgs();
  testPresetMode();
  testMinimality();
  testPreservesNonLocationFields();

  for (const failure of failures) console.error("FAIL " + failure);
  console.log(passed + " passed, " + failed + " failed");
  return failed === 0;
}

if (import.meta.url === "file://" + process.argv[1]) {
  runTests();
}
