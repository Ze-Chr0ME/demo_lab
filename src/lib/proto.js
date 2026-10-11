// Minimal protobuf wire-format reader/writer — enough for the few Game Coordinator messages we use.

function readVarint(buf, pos) {
  let result = 0n, shift = 0n, b;
  do {
    if (pos >= buf.length) throw new Error('Truncated varint');
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return [result, pos];
}

// Returns { [fieldNumber]: [values...] }. Varints come back as BigInt, length-delimited as Buffer.
function decode(buf) {
  const fields = {};
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    let value;
    if (wire === 0) [value, pos] = readVarint(buf, pos);
    else if (wire === 1) { value = buf.readBigUInt64LE(pos); pos += 8; }
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + Number(len));
      pos += Number(len);
    } else if (wire === 5) { value = buf.readUInt32LE(pos); pos += 4; }
    else throw new Error(`Unsupported wire type ${wire}`);
    (fields[field] ||= []).push(value);
  }
  return fields;
}

// Packed repeated varints (proto3 style) or plain repeated values.
function ints(values) {
  if (!values) return [];
  const out = [];
  for (const v of values) {
    if (Buffer.isBuffer(v)) { let p = 0, x; while (p < v.length) { [x, p] = readVarint(v, p); out.push(Number(BigInt.asIntN(32, x))); } }
    else out.push(Number(BigInt.asIntN(32, BigInt(v))));
  }
  return out;
}

function writeVarint(n) {
  let v = BigInt(n);
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}

// encode([[fieldNumber, varintValue], ...]) — varint fields only.
function encodeVarints(pairs) {
  return Buffer.concat(pairs.flatMap(([f, v]) => [writeVarint((BigInt(f) << 3n) | 0n), writeVarint(v)]));
}

module.exports = { decode, ints, encodeVarints };
