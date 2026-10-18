// Zstandard JSONL session-log primitives.
// Mirrors the frame container used by @deepseek-ai/dsh-session-persistence-jsonl:
// a checksummed first frame containing exactly one header line, followed by
// zero or more independently decodable event frames.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const ZSTD_MAGIC = 0xfd2fb528;
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

/**
 * Locate complete Zstandard frames without decompressing them.
 * @returns {{frames: {start:number,end:number}[], tornStart?: number}}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`Zstandard 帧格式错误：字节 ${offset} 处的 magic 不正确`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`Zstandard 帧头保留了未知位（字节 ${offset - 1}）`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`Zstandard 帧包含保留的块类型（字节 ${offset - 3}）`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

export function decompressFrame(buffer) {
  return zlib.zstdDecompressSync(buffer).toString('utf8');
}

export function compressFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM_OPTIONS);
}

/** Decompress every complete frame and concatenate its JSONL text. */
export function readZstdText(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer);
  if (frames.length === 0) throw new Error('空的 Zstandard 会话日志（没有完整帧）');
  let text = '';
  for (const frame of frames) text += decompressFrame(buffer.subarray(frame.start, frame.end));
  return { text, frames, tornStart };
}

function normalizeJsonl(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Parse and split a canonical JSONL session log (header line + event lines). */
export function parseSessionJsonl(text) {
  const normalized = normalizeJsonl(text);
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new Error('会话日志为空');
  const header = JSON.parse(lines[0]);
  if (header.type !== 'session' || typeof header.id !== 'string') {
    throw new Error('会话日志第一行不是有效的 Session header');
  }
  return { header, lines, eventLines: lines.slice(1) };
}

/** Encode canonical JSONL as a header frame plus bounded event frames. */
export function encodeSessionJsonl(lines, maxFrameBytes = 1024 * 1024) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('没有可编码的会话行');
  const frames = [];
  frames.push(compressFrame(`${lines[0]}\n`));
  let chunk = [];
  let chunkBytes = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    frames.push(compressFrame(`${chunk.join('\n')}\n`));
    chunk = [];
    chunkBytes = 0;
  };
  for (const line of lines.slice(1)) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (chunk.length > 0 && chunkBytes + bytes > maxFrameBytes) flush();
    chunk.push(line);
    chunkBytes += bytes;
  }
  flush();
  return Buffer.concat(frames);
}

/** Read the header line from a stored session artifact (.jsonl or .jsonl.zstd). */
export function readStoredSessionHeader(file) {
  if (file.endsWith('.zstd')) {
    const buffer = fs.readFileSync(file);
    const { frames } = scanZstdFrames(buffer, 1);
    if (frames.length === 0) throw new Error(`会话日志没有完整的 header 帧：${file}`);
    const text = decompressFrame(buffer.subarray(frames[0].start, frames[0].end));
    if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) {
      throw new Error(`会话日志的 header 帧不是单独一行：${file}`);
    }
    const header = JSON.parse(text.slice(0, -1));
    if (header.type !== 'session' || typeof header.id !== 'string') {
      throw new Error(`会话 header 无效：${file}`);
    }
    return { header, compression: 'zstd', version: Number(header.version) || 0 };
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const line = text.split(/\r?\n/, 1)[0];
  const header = JSON.parse(line);
  if (header.type !== 'session' || typeof header.id !== 'string') {
    throw new Error(`会话 header 无效：${file}`);
  }
  return { header, compression: 'none', version: Number(header.version) || 0 };
}

/** Read the complete logical log text and all frames (works for zstd and plain JSONL). */
export function readStoredSessionText(file) {
  if (file.endsWith('.zstd')) {
    const buffer = fs.readFileSync(file);
    const result = readZstdText(buffer);
    return { ...result, compression: 'zstd' };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { text, frames: [], tornStart: undefined, compression: 'none' };
}

function atomicWriteFile(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, buffer);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

/**
 * Rewrite only the header frame's cwd while preserving every event frame byte-for-byte.
 * @returns {boolean} whether the file changed
 */
export function rewriteStoredSessionCwd(file, newCwd, options = {}) {
  if (file.endsWith('.jsonl')) {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseSessionJsonl(text);
    if (parsed.header.cwd === newCwd) return false;
    parsed.header.cwd = newCwd;
    const lines = [JSON.stringify(parsed.header), ...parsed.eventLines];
    atomicWriteFile(file, Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
    return true;
  }
  const buffer = fs.readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(buffer);
  if (frames.length === 0) throw new Error(`会话日志没有完整帧：${file}`);
  const headerText = decompressFrame(buffer.subarray(frames[0].start, frames[0].end));
  if (!headerText.endsWith('\n') || headerText.indexOf('\n') !== headerText.length - 1) {
    throw new Error(`无法安全改写：header 帧不是单独一行（${file}）`);
  }
  const header = JSON.parse(headerText.slice(0, -1));
  if (header.type !== 'session') throw new Error(`无法安全改写：header 无效（${file}）`);
  if (header.cwd === newCwd) return false;
  header.cwd = newCwd;
  const newHeaderFrame = compressFrame(`${JSON.stringify(header)}\n`);
  const tailStart = frames.length > 1 ? frames[1].start : buffer.length;
  const tail = buffer.subarray(tailStart);
  atomicWriteFile(file, Buffer.concat([newHeaderFrame, tail]));
  // Validate the new header frame so a bad compressor cannot silently break a log.
  const verify = fs.readFileSync(file);
  const verifyFrames = scanZstdFrames(verify, 1).frames;
  if (verifyFrames.length === 0) throw new Error(`改写后的会话日志无效：${file}`);
  const verifyHeader = JSON.parse(decompressFrame(verify.subarray(verifyFrames[0].start, verifyFrames[0].end)).slice(0, -1));
  if (verifyHeader.id !== header.id || verifyHeader.cwd !== newCwd) {
    throw new Error(`改写后的会话 header 校验失败：${file}`);
  }
  if (options.verbose && tornStart !== undefined) {
    console.warn(`  注意：${path.basename(file)} 末尾有不完整帧，已原样保留。`);
  }
  return true;
}

/** Write a canonical JSONL log as a new zstd session artifact. */
export function writeStoredSessionFromJsonl(file, text) {
  const { lines } = parseSessionJsonl(text);
  const encoded = encodeSessionJsonl(lines);
  atomicWriteFile(file, encoded);
  return readStoredSessionHeader(file).header;
}

/** Copy a session artifact, rewriting its cwd if needed. */
export function copySessionArtifact(source, destination, newCwd) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (newCwd !== undefined) rewriteStoredSessionCwd(destination, newCwd);
}
