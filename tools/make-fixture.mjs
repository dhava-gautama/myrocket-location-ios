#!/usr/bin/env node
/**
 * Generate test/fixtures/arpc-response.hex — a synthetic ARPC-framed
 * /clls/wloc response containing 2 wifi + 1 cell records at the default
 * Apple Park coordinates.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concatBytes,
  makeLengthDelimitedField,
  makeVarintField,
  serializeArpcEnvelope,
} from "../core/wloc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function location(latScaled, lngScaled, hacc) {
  return concatBytes([
    makeVarintField(1, latScaled),
    makeVarintField(2, lngScaled),
    makeVarintField(3, hacc),
  ]);
}

function wifiDevice(latScaled, lngScaled, hacc, macHex) {
  const mac = new Uint8Array((macHex.match(/../g) || []).map((b) => parseInt(b, 16)));
  return concatBytes([
    makeLengthDelimitedField(2, location(latScaled, lngScaled, hacc)),
    makeLengthDelimitedField(3, mac),
  ]);
}

function cellTower(latScaled, lngScaled, hacc, mcc, cid) {
  return concatBytes([
    makeVarintField(1, mcc),
    makeLengthDelimitedField(5, location(latScaled, lngScaled, hacc)),
    makeVarintField(6, cid),
  ]);
}

const AP = { lat: 3733490000, lng: -12200902000 };

const root = concatBytes([
  makeLengthDelimitedField(2, wifiDevice(AP.lat, AP.lng, 39, "a4f1e8001234")),
  makeLengthDelimitedField(2, wifiDevice(AP.lat - 5000000, AP.lng + 3000000, 42, "a4f1e8005678")),
  makeLengthDelimitedField(22, cellTower(AP.lat + 9000000, AP.lng - 2000000, 85, 310, 123456789)),
  makeVarintField(3, 1), // field 3: result marker, passed through untouched
]);

const envelope = serializeArpcEnvelope({
  version: 1,
  locale: "en_US",
  appIdentifier: "com.apple.locationd",
  osVersion: "17.5.1",
  functionId: 1,
  payload: root,
});

const hex = Buffer.from(envelope).toString("hex");
const target = join(ROOT, "test", "fixtures", "arpc-response.hex");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, hex + "\n");
console.log("wrote " + target + " (" + envelope.length + " bytes)");
