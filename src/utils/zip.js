'use strict';
/** A minimal ZIP writer (no compression: photos are already compressed), enough to hand several files to the admin in one download. */
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc32.table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A streaming ZIP writer: add(name, data) returns the bytes to send for that file, finish() the closing directory.
 * Only the names and sizes are kept, never the files, so a big export does not sit in memory.
 */
function writer() {
  const centrals = []; let offset = 0;
  return {
    add(rawName, data) {
      const name = Buffer.from(String(rawName).replace(/[\\:*?"<>|]+/g, '_'), 'utf8');
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
      local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
      central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
      centrals.push(central, name);
      offset += 30 + name.length + data.length;
      return Buffer.concat([local, name, data]);
    },
    finish() {
      const cd = Buffer.concat(centrals);
      const end = Buffer.alloc(22);
      const count = centrals.length / 2;
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
      return Buffer.concat([cd, end]);
    },
  };
}

/** files: [{ name, data: Buffer }] -> Buffer */
function build(files) {
  const w = writer();
  const parts = files.map((f) => w.add(f.name, f.data));
  parts.push(w.finish());
  return Buffer.concat(parts);
}

module.exports = { build, writer, crc32 };
