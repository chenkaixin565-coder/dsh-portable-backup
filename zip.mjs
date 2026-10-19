// Minimal, dependency-free ZIP reader/writer used by dsh-portable.
// Supports the subset produced by the DSH session export and by this tool:
// stored (0) and deflate (8) entries, UTF-8 or CP437-ish names (decoded as UTF-8).
// ZIP64 is rejected with a clear message instead of silently corrupting data.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function toUInt32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/** Read a ZIP archive from disk. Entries stay compressed until read(). */
export class ZipReader {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.entries = [];
    this.byName = new Map();
    this.#readCentralDirectory();
  }

  #readAt(position, length) {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(this.fd, buffer, 0, length, position);
    return read === length ? buffer : buffer.subarray(0, read);
  }

  #findEocd() {
    const tailSize = Math.min(this.size, 65557);
    const tail = this.#readAt(this.size - tailSize, tailSize);
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLength === tail.length) return this.size - tailSize + i;
    }
    throw new Error(`不是有效的 ZIP 文件（找不到中央目录结尾）：${this.file}`);
  }

  #readCentralDirectory() {
    const eocd = this.#findEocd();
    const header = this.#readAt(eocd, 22);
    const total = header.readUInt16LE(10);
    const cdSize = header.readUInt32LE(12);
    const cdOffset = header.readUInt32LE(16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式，请改用文件夹备份或将 ZIP 拆分后重试。');
    }
    const cd = this.#readAt(cdOffset, cdSize);
    let offset = 0;
    for (let index = 0; index < total; index++) {
      if (offset + 46 > cd.length || cd.readUInt32LE(offset) !== SIG_CENTRAL) {
        throw new Error(`ZIP 中央目录损坏（第 ${index + 1} 项）。`);
      }
      const flags = cd.readUInt16LE(offset + 8);
      const method = cd.readUInt16LE(offset + 10);
      const crc = cd.readUInt32LE(offset + 16);
      const compressedSize = cd.readUInt32LE(offset + 20);
      const uncompressedSize = cd.readUInt32LE(offset + 24);
      const nameLength = cd.readUInt16LE(offset + 28);
      const extraLength = cd.readUInt16LE(offset + 30);
      const commentLength = cd.readUInt16LE(offset + 32);
      const localOffset = cd.readUInt32LE(offset + 42);
      const name = cd.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      if (flags & 1) throw new Error(`ZIP 条目已加密，无法读取：${name}`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error(`ZIP 条目使用 ZIP64 扩展，暂不支持：${name}`);
      }
      const entry = { name, flags, method, crc, compressedSize, uncompressedSize, localOffset };
      this.entries.push(entry);
      this.byName.set(name, entry);
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  has(name) {
    return this.byName.has(name);
  }

  find(regex) {
    return this.entries.filter((entry) => regex.test(entry.name));
  }

  /** @returns {Buffer} uncompressed bytes */
  read(entryOrName) {
    const entry = typeof entryOrName === 'string' ? this.byName.get(entryOrName) : entryOrName;
    if (!entry) throw new Error(`ZIP 中不存在条目：${entryOrName}`);
    const local = this.#readAt(entry.localOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) {
      throw new Error(`ZIP 条目的本地头损坏：${entry.name}`);
    }
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const raw = this.#readAt(dataStart, entry.compressedSize);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`);
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`ZIP 条目长度不符：${entry.name}（期望 ${entry.uncompressedSize}，实际 ${data.length}）`);
    }
    if (crc32(data) !== entry.crc) throw new Error(`ZIP 条目 CRC 校验失败：${entry.name}`);
    return data;
  }

  readText(entryOrName) {
    return this.read(entryOrName).toString('utf8');
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

/** Sequential ZIP writer. Synchronous writes keep the implementation small and predictable. */
export class ZipWriter {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'w');
    this.offset = 0;
    this.entries = [];
  }

  #write(buffer) {
    fs.writeSync(this.fd, buffer, 0, buffer.length);
    this.offset += buffer.length;
  }

  addFile(name, data, mtime = new Date()) {
    if (this.entries.some((entry) => entry.name === name)) {
      throw new Error(`ZIP 中重复的条目名：${name}`);
    }
    const nameBuffer = Buffer.from(name, 'utf8');
    const { dosTime, dosDate } = dosDateTime(mtime);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const flags = 0x0800; // UTF-8 file name
    const localOffset = this.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    this.#write(local);
    this.#write(nameBuffer);
    this.#write(payload);

    this.entries.push({
      name, nameBuffer, flags, method, dosTime, dosDate, crc,
      compressedSize: payload.length, uncompressedSize: data.length, localOffset,
    });
  }

  addFileFromPath(name, filePath, mtime) {
    this.addFile(name, fs.readFileSync(filePath), mtime ?? fs.statSync(filePath).mtime);
  }

  close() {
    const centralStart = this.offset;
    for (const entry of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(SIG_CENTRAL, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(entry.flags, 8);
      central.writeUInt16LE(entry.method, 10);
      central.writeUInt16LE(entry.dosTime, 12);
      central.writeUInt16LE(entry.dosDate, 14);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(entry.compressedSize, 20);
      central.writeUInt32LE(entry.uncompressedSize, 24);
      central.writeUInt16LE(entry.nameBuffer.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(entry.localOffset, 42);
      this.#write(central);
      this.#write(entry.nameBuffer);
    }
    const centralSize = this.offset - centralStart;
    if (this.entries.length > 0xffff) throw new Error('ZIP 条目数超过 65535，暂不支持。');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    this.#write(eocd);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

export function isZipFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    return buffer.readUInt32LE(0) === SIG_LOCAL;
  } catch {
    return false;
  }
}
