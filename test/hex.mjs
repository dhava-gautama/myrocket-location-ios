/** Hex helpers shared by tests and the CLI. */

export function hexToBytes(hex) {
  const clean = hex.replace(/0x/g, "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes, limit) {
  const max = limit && limit > 0 ? Math.min(bytes.length, limit) : bytes.length;
  let out = "";
  for (let i = 0; i < max; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
