// A small .zip writer (streamed, no compression: photos are already compressed) and reader, with Zip64 so a
// download with years of photos (over 4 GB) still opens. Used for "Download a copy" and `npm run restore -- file.zip`.
const fs = require('node:fs');
const zlib = require('node:zlib');

const U32 = 0xffffffff;

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * zipWriter(write) — write(buf) sends bytes on (it may return a promise, e.g. to wait for a slow download).
 * await z.add(name, buffer, date?) for each file, then await z.end().
 */
function zipWriter(write, { zip64At = U32 } = {}) {
  let offset = 0;
  const LIM = zip64At; // tests lower this to check the Zip64 path without writing 4 GB
  const central = [];
  const out = async (buf) => { offset += buf.length; await write(buf); };

  async function add(name, data, date = new Date()) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const size = data.length;
    const { time, date: d } = dosTime(date);
    const start = offset;
    const big = size >= LIM;
    const zip64Local = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) {
      zip64Local.writeUInt16LE(0x0001, 0); zip64Local.writeUInt16LE(16, 2);
      zip64Local.writeBigUInt64LE(BigInt(size), 4); zip64Local.writeBigUInt64LE(BigInt(size), 12);
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(big ? 45 : 20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(0, 8); // stored
    h.writeUInt16LE(time, 10); h.writeUInt16LE(d, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(big ? U32 : size, 18); h.writeUInt32LE(big ? U32 : size, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(zip64Local.length, 28);
    await out(Buffer.concat([h, nameBuf, zip64Local]));
    await out(data);
    central.push({ nameBuf, crc, size, time, d, start });
  }

  async function end() {
    const cdStart = offset;
    for (const e of central) {
      const needs = e.size >= LIM || e.start >= LIM;
      const extra = [];
      if (e.size >= LIM) extra.push(BigInt(e.size), BigInt(e.size));
      if (e.start >= LIM) extra.push(BigInt(e.start));
      const x = needs ? Buffer.alloc(4 + extra.length * 8) : Buffer.alloc(0);
      if (needs) {
        x.writeUInt16LE(0x0001, 0); x.writeUInt16LE(extra.length * 8, 2);
        extra.forEach((v, i) => x.writeBigUInt64LE(v, 4 + i * 8));
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(needs ? 45 : 20, 6);
      c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.d, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size >= LIM ? U32 : e.size, 20); c.writeUInt32LE(e.size >= LIM ? U32 : e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt16LE(x.length, 30);
      c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      c.writeUInt32LE(e.start >= LIM ? U32 : e.start, 42);
      await out(Buffer.concat([c, e.nameBuf, x]));
    }
    const cdSize = offset - cdStart;
    const n = central.length;
    const z64needed = n >= 0xffff || cdStart >= LIM || cdSize >= LIM;
    if (z64needed) {
      const z64 = Buffer.alloc(56);
      const z64Start = offset;
      z64.writeUInt32LE(0x06064b50, 0); z64.writeBigUInt64LE(44n, 4);
      z64.writeUInt16LE(45, 12); z64.writeUInt16LE(45, 14);
      z64.writeBigUInt64LE(BigInt(n), 24); z64.writeBigUInt64LE(BigInt(n), 32);
      z64.writeBigUInt64LE(BigInt(cdSize), 40); z64.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(z64Start), 8); loc.writeUInt32LE(1, 16);
      await out(Buffer.concat([z64, loc]));
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(z64needed ? 0xffff : n, 8); eocd.writeUInt16LE(z64needed ? 0xffff : n, 10);
    eocd.writeUInt32LE(z64needed ? U32 : cdSize, 12); eocd.writeUInt32LE(z64needed ? U32 : cdStart, 16);
    await out(eocd);
    return offset;
  }

  return { add, end, get size() { return offset; } };
}

/** Read a .zip file from disk without loading it all: { entries: [{ name, size }], read(entry) → Buffer }. */
function readZip(file) {
  const fd = fs.openSync(file, 'r');
  const total = fs.fstatSync(fd).size;
  const readAt = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
  const tailLen = Math.min(total, 65557);
  const tail = readAt(total - tailLen, tailLen);
  const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) { fs.closeSync(fd); throw new Error('That is not a zip file'); }
  let count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdStart = tail.readUInt32LE(at + 16);
  if (cdStart === U32 || count === 0xffff || cdSize === U32) {
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), at);
    const z64 = readAt(Number(tail.readBigUInt64LE(loc + 8)), 56);
    count = Number(z64.readBigUInt64LE(32)); cdSize = Number(z64.readBigUInt64LE(40)); cdStart = Number(z64.readBigUInt64LE(48));
  }
  const cd = readAt(cdStart, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let size = cd.readUInt32LE(p + 24);
    const csize = cd.readUInt32LE(p + 20);
    let offset = cd.readUInt32LE(p + 42);
    const method = cd.readUInt16LE(p + 10);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === U32) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === U32) q += 8;
        if (offset === U32) offset = Number(cd.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    entries.push({ name, size, offset, method, csize: csize === U32 ? size : csize });
    p = xEnd + commentLen;
  }
  function read(e) {
    const h = readAt(e.offset, 30);
    const start = e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    const raw = readAt(start, e.method === 0 ? e.size : e.csize);
    return e.method === 8 ? zlib.inflateRawSync(raw) : raw;
  }
  return { entries, read, close: () => fs.closeSync(fd) };
}

module.exports = { zipWriter, readZip };
