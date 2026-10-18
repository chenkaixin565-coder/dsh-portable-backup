// Backup, restore, and official `/export` ZIP import for DeepSeek Harness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ZipReader, ZipWriter, isZipFile } from './zip.mjs';
import {
  parseSessionJsonl,
  readZstdText,
  rewriteStoredSessionCwd,
  writeStoredSessionFromJsonl,
} from './zstd.mjs';
import {
  buildPathMapper,
  clearProjectionCache,
  deriveTitleFromLog,
  ensureDir,
  findDefaultWorkspacePath,
  listSessions,
  pathExistsDirectory,
  readWorkspaceState,
  sessionArtifactPath,
} from './session.mjs';
import {
  detachSessionsFromWorkspaces,
  mergeWorkspaceStates,
  prepareWorkspaceForImport,
  transformWorkspacePaths,
  writeWorkspaceState,
} from './workspace.mjs';

export const TOOL_VERSION = '1.0.0';
export const BACKUP_FORMAT = 'dsh-portable-backup';
export const BACKUP_VERSION = 1;

const SKIP_ATTACHMENT_DIRS = new Set(['tmp']);
const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function isDshRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const tasklist = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');
    const output = execFileSync(tasklist, ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /DeepSeek Harness\.exe/i.test(output);
  } catch {
    return false;
  }
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** Only create missing directories under the current user profile (or DSH home) by default. */
export function isSafeCreatePath(candidate, home) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  const target = normalize(candidate);
  const userHome = normalize(os.homedir());
  const dshParent = normalize(path.dirname(home));
  return target === userHome || target.startsWith(`${userHome}\\`) || target === dshParent || target.startsWith(`${dshParent}\\`);
}

export function formatTime(value) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function walkFiles(root, options = {}) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  const visit = (directory, relative) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (options.skipName?.(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (options.skipDir?.(entry.name, rel)) continue;
        visit(absolute, rel);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        result.push({ absolute, relative: rel, size: stat.size, mtime: stat.mtime, mode: stat.mode });
      }
    }
  };
  visit(root, '');
  return result;
}

function copyFileAtomic(source, destination, mode) {
  ensureDir(path.dirname(destination));
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(source, temporary);
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  if (mode !== undefined) {
    try { fs.chmodSync(destination, mode); } catch {}
  }
}

function writeFileAtomic(destination, buffer, mode) {
  ensureDir(path.dirname(destination));
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, buffer);
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  if (mode !== undefined) {
    try { fs.chmodSync(destination, mode); } catch {}
  }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function sessionEntryForManifest(record, home) {
  const relativeToSessions = path.relative(path.join(home, 'sessions'), record.directory);
  return {
    id: record.id,
    cwd: record.cwd,
    createdAt: record.createdAt,
    title: record.title ?? null,
    parentSession: record.parentSession ?? null,
    delegationDepth: record.delegationDepth ?? 0,
    version: record.version,
    compression: record.compression,
    bytes: record.bytes,
    directory: relativeToSessions.replace(/\\/g, '/'),
  };
}

/**
 * Create a portable backup as a folder or ZIP.
 * @returns {{manifest: object, output: string, files: number, bytes: number}}
 */
export function createBackup(home, output, options = {}) {
  const zip = options.zip ?? String(output).toLowerCase().endsWith('.zip');
  if (!fs.existsSync(home)) throw new Error(`DSH 数据目录不存在：${home}`);
  ensureDir(path.dirname(path.resolve(output)));
  const running = isDshRunning();
  if (running && options.requireClosed && !options.force) {
    throw new Error(
      '检测到 DeepSeek Harness 正在运行。\n' +
        '请先完全退出 DSH（托盘图标 → 退出），再运行备份。\n' +
        '如果只想做热备份，可以去掉 --require-closed 或加 --force。',
    );
  }
  if (fs.existsSync(output)) {
    if (!options.force) {
      throw new Error(`输出位置已存在：${output}\n请换一个名字，或加 --force 覆盖。`);
    }
    fs.rmSync(output, { recursive: true, force: true });
  }

  const records = listSessions(home, { withTitles: true });
  const sessions = records.map((record) => {
    const entry = sessionEntryForManifest(record, home);
    if (!entry.title && !record.error) entry.title = deriveTitleFromLog(record);
    if (record.error) entry.error = record.error;
    return entry;
  });

  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    hotBackup: running,
    source: {
      dshHome: home,
      userProfile: os.homedir(),
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      username: os.userInfo().username,
      node: process.version,
      dshVersion: process.env.DSH_VERSION ?? null,
    },
    options: {
      settings: Boolean(options.settings),
      credentials: Boolean(options.credentials),
    },
    sessions,
  };

  const entries = [];
  const sessionsRoot = path.join(home, 'sessions');
  for (const file of walkFiles(sessionsRoot, { skipName: (name) => name.includes('.tmp-') })) {
    if (!SESSION_FILE_RE.test(path.basename(file.absolute))) continue;
    entries.push({ name: `sessions/${file.relative.replace(/\\/g, '/')}`, ...file });
  }

  const attachmentsRoot = path.join(home, 'attachments', 'v1');
  for (const file of walkFiles(attachmentsRoot, {
    skipName: (name) => name.includes('.tmp-'),
    skipDir: (name, relative) => SKIP_ATTACHMENT_DIRS.has(name) && relative.split(path.sep).length === 1,
  })) {
    if (file.relative.split(path.sep).some((part) => SKIP_ATTACHMENT_DIRS.has(part))) continue;
    entries.push({ name: `attachments/v1/${file.relative.replace(/\\/g, '/')}`, ...file });
  }

  const workspaceFile = path.join(home, 'storages', 'workspace.json');
  if (fs.existsSync(workspaceFile)) {
    const stat = fs.statSync(workspaceFile);
    entries.push({ name: 'storages/workspace.json', absolute: workspaceFile, relative: 'storages/workspace.json', size: stat.size, mtime: stat.mtime });
  }

  if (options.settings) {
    const profilesRoot = path.join(home, 'profiles');
    for (const file of walkFiles(profilesRoot)) {
      entries.push({ name: `profiles/${file.relative.replace(/\\/g, '/')}`, ...file });
    }
  }
  if (options.credentials) {
    const credentials = path.join(home, '.credentials.yaml');
    if (fs.existsSync(credentials)) {
      const stat = fs.statSync(credentials);
      entries.push({ name: '.credentials.yaml', absolute: credentials, relative: '.credentials.yaml', size: stat.size, mtime: stat.mtime });
    }
  }

  let totalBytes = 0;
  if (zip) {
    const writer = new ZipWriter(output);
    writer.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    let count = 0;
    for (const entry of entries) {
      const data = fs.readFileSync(entry.absolute);
      writer.addFile(`data/${entry.name}`, data, entry.mtime);
      totalBytes += data.length;
      count++;
      if (options.onProgress && count % 50 === 0) options.onProgress(`  已打包 ${count} 个文件，${formatBytes(totalBytes)}`);
    }
    writer.close();
    return { manifest, output, files: entries.length + 1, bytes: totalBytes };
  }

  ensureDir(output);
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const entry of entries) {
    const destination = path.join(output, 'data', entry.name);
    copyFileAtomic(entry.absolute, destination, entry.mode);
    totalBytes += entry.size;
  }
  return { manifest, output, files: entries.length + 1, bytes: totalBytes };
}

/** Open a folder or ZIP backup. */
export function openBackup(input) {
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    const manifestFile = path.join(input, 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error(`不是 DSH 便携备份：缺少 manifest.json\n${input}`);
    const manifest = readJsonFile(manifestFile);
    if (manifest.format !== BACKUP_FORMAT) throw new Error(`备份格式不匹配：${manifest.format ?? '未知'}`);
    return {
      kind: 'dir',
      input,
      root: input,
      dataRoot: path.join(input, 'data'),
      manifest,
      has(rel) { return fs.existsSync(path.join(this.dataRoot, rel)); },
      read(rel) { return fs.readFileSync(path.join(this.dataRoot, rel)); },
      list(prefix) {
        const base = path.join(this.dataRoot, prefix);
        if (!fs.existsSync(base)) return [];
        return walkFiles(base).map((file) => `${prefix.replace(/[\\/]+$/, '')}/${file.relative.replace(/\\/g, '/')}`.replace(/^\/+/, ''));
      },
      close() {},
    };
  }

  if (!isZipFile(input)) throw new Error(`不支持的备份文件（既不是文件夹也不是 ZIP）：${input}`);
  const zip = new ZipReader(input);
  if (!zip.has('manifest.json')) {
    zip.close();
    throw new Error('这个 ZIP 不是 DSH 便携备份（缺少 manifest.json）。\n如果它是 DSH 的 /export 会话包，请使用“导入会话 ZIP”功能。');
  }
  const manifest = JSON.parse(zip.readText('manifest.json').replace(/^\uFEFF/, ''));
  if (manifest.format !== BACKUP_FORMAT) {
    zip.close();
    throw new Error(`备份格式不匹配：${manifest.format ?? '未知'}`);
  }
  return {
    kind: 'zip',
    input,
    root: null,
    dataRoot: null,
    zip,
    manifest,
    has(rel) { return zip.has(`data/${rel}`); },
    read(rel) { return zip.read(`data/${rel}`); },
    list(prefix) {
      const normalized = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
      return zip.entries
        .map((entry) => entry.name)
        .filter((name) => name.startsWith(`data/${normalized}/`))
        .map((name) => name.slice('data/'.length));
    },
    close() { zip.close(); },
  };
}

function restoreAttachmentsFromBackup(backup, home, options) {
  const root = path.join(home, 'attachments', 'v1');
  const names = backup.list('attachments/v1');
  let restored = 0;
  let skipped = 0;
  let bytes = 0;
  for (const rel of names) {
    const relative = rel.replace(/^attachments\/v1\//, '');
    if (relative.split('/').some((part) => SKIP_ATTACHMENT_DIRS.has(part))) continue;
    if (relative.endsWith('/') || relative === '') continue;
    const destination = path.join(root, relative);
    if (fs.existsSync(destination)) {
      skipped++;
      continue;
    }
    if (options.dryRun) {
      restored++;
      continue;
    }
    const data = backup.read(rel);
    writeFileAtomic(destination, data, 0o444);
    restored++;
    bytes += data.length;
  }
  return { restored, skipped, bytes };
}

function copySettingsFromBackup(backup, home, options) {
  const names = backup.list('profiles');
  let copied = 0;
  for (const rel of names) {
    const relative = rel.replace(/^profiles\//, '');
    if (relative === '' || relative.endsWith('/')) continue;
    const destination = path.join(home, 'profiles', relative);
    if (options.dryRun) { copied++; continue; }
    const data = backup.read(rel);
    writeFileAtomic(destination, data);
    copied++;
  }
  return copied;
}

/**
 * Restore a full portable backup into a DSH home.
 * @returns {object} summary
 */
export function restoreBackup(input, home, options = {}) {
  const backup = openBackup(input);
  try {
    if (isDshRunning() && !options.force) {
      throw new Error(
        '检测到 DeepSeek Harness 正在运行。\n' +
          '恢复会改写 sessions/ 与 workspace.json，必须先完全退出 DSH（托盘图标 → 退出）。\n' +
          '如果只是演练，可以加 --dry-run；确认要强行写入可加 --force。',
      );
    }
    const targetHome = path.resolve(home);
    const manifest = backup.manifest;
    const mapper = buildPathMapper({
      manifestHome: manifest.source?.dshHome,
      targetHome,
      maps: options.map ?? [],
    });
    const mode = options.mode === 'replace' ? 'replace' : 'merge';

    if (mode === 'replace' && !options.dryRun) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const sessionsDir = path.join(targetHome, 'sessions');
      if (fs.existsSync(sessionsDir)) {
        fs.renameSync(sessionsDir, path.join(targetHome, `sessions.bak-${stamp}`));
      }
      const workspaceFile = path.join(targetHome, 'storages', 'workspace.json');
      if (fs.existsSync(workspaceFile)) {
        fs.renameSync(workspaceFile, `${workspaceFile}.bak-${stamp}`);
      }
    }

    const restored = [];
    const skipped = [];
    const missingWorkspaces = new Set();
    const existingById = new Map(listSessions(targetHome, { withTitles: false }).map((record) => [record.id, record.directory]));
    for (const entry of manifest.sessions ?? []) {
      if (!entry?.id) continue;
      const existingDir = existingById.get(entry.id);
      if (existingDir) {
        if (!options.overwrite) {
          skipped.push({ id: entry.id, reason: '目标 DSH 已有同一 ID 的会话（默认保留现有）' });
          continue;
        }
        if (!options.dryRun) fs.rmSync(existingDir, { recursive: true, force: true });
        existingById.delete(entry.id);
      }
      const sourceRelative = `sessions/${entry.directory}/session${entry.version >= 1 ? `.v${entry.version}` : ''}.jsonl${entry.compression === 'zstd' ? '.zstd' : ''}`;
      let source = null;
      if (backup.has(sourceRelative)) source = sourceRelative;
      else {
        const candidates = backup.list(`sessions/${entry.directory}`).filter((rel) => SESSION_FILE_RE.test(path.basename(rel)));
        if (candidates.length > 0) source = candidates.sort().at(-1);
      }
      if (!source) {
        skipped.push({ id: entry.id, reason: '备份中找不到会话文件' });
        continue;
      }
      let header;
      if (!entry.cwd) {
        try {
          const buffer = backup.read(source);
          const text = source.endsWith('.zstd') ? readZstdText(buffer).text : buffer.toString('utf8');
          header = parseSessionJsonl(text).header;
        } catch {}
      }
      const oldCwd = entry.cwd ?? header?.cwd;
      let newCwd = options.workspace && options.forceWorkspace ? options.workspace : mapper.map(oldCwd);
      if (!newCwd || typeof newCwd !== 'string') {
        if (options.workspace) newCwd = options.workspace;
        else {
          skipped.push({ id: entry.id, reason: '会话没有 cwd，且没有指定目标工作区' });
          continue;
        }
      }
      if (!path.isAbsolute(newCwd)) {
        skipped.push({ id: entry.id, reason: `目标工作区不是绝对路径：${newCwd}` });
        continue;
      }
      if (!pathExistsDirectory(newCwd)) {
        const explicitlyChosen = options.workspace && path.resolve(newCwd).toLowerCase() === path.resolve(options.workspace).toLowerCase();
        if (
          options.createWorkspaces === false ||
          (!explicitlyChosen && !options.createAnywhere && !isSafeCreatePath(newCwd, targetHome))
        ) {
          missingWorkspaces.add(newCwd);
          skipped.push({ id: entry.id, reason: `目标工作区不存在，且不在当前用户目录：${newCwd}` });
          continue;
        }
        try {
          if (!options.dryRun) ensureDir(newCwd);
        } catch (error) {
          missingWorkspaces.add(newCwd);
          skipped.push({ id: entry.id, reason: `无法创建工作区 ${newCwd}：${error.message}` });
          continue;
        }
      }
      const target = sessionArtifactPath(targetHome, newCwd, entry.id, entry.version ?? 4, entry.compression ?? 'zstd');
      if (fs.existsSync(target) && !options.overwrite) {
        skipped.push({ id: entry.id, reason: '目标位置已有同名会话' });
        continue;
      }
      const data = backup.read(source);
      if (!options.dryRun) {
        writeFileAtomic(target, data);
        if (oldCwd !== newCwd) rewriteStoredSessionCwd(target, newCwd, { verbose: true });
      }
      restored.push({ id: entry.id, cwd: newCwd, file: target });
    }

    const attachmentSummary = options.attachments === false
      ? { restored: 0, skipped: 0, bytes: 0 }
      : restoreAttachmentsFromBackup(backup, targetHome, options);

    let workspaceSummary = 'none';
    if (backup.has('storages/workspace.json')) {
      const restoredIds = new Set(restored.map((record) => record.id));
      if (mode === 'merge' && !options.dryRun) {
        detachSessionsFromWorkspaces(targetHome, [...restoredIds]);
      }
      const incoming = transformWorkspacePaths(JSON.parse(backup.read('storages/workspace.json').toString('utf8').replace(/^\uFEFF/, '')), mapper);
      for (const record of Object.values(incoming.tables?.workspaces ?? {})) {
        record.sessionIds = (record.sessionIds ?? []).filter((id) => restoredIds.has(id));
      }
      const current = readWorkspaceState(targetHome).data;
      let result;
      if (mode === 'merge' && current) result = mergeWorkspaceStates(current, incoming);
      else result = incoming;
      result.global.initialized = false;
      if (!options.dryRun) writeWorkspaceState(path.join(targetHome, 'storages', 'workspace.json'), result);
      workspaceSummary = 'restored';
    } else if (!options.dryRun) {
      prepareWorkspaceForImport(targetHome);
      workspaceSummary = 'initialized-empty';
    }

    let settingsCount = 0;
    if (options.settings && backup.list('profiles').length > 0) {
      settingsCount = copySettingsFromBackup(backup, targetHome, options);
    }
    if (options.credentials && backup.has('.credentials.yaml')) {
      if (!options.dryRun) {
        writeFileAtomic(path.join(targetHome, '.credentials.yaml'), backup.read('.credentials.yaml'), 0o600);
      }
    }

    if (!options.dryRun) {
      clearProjectionCache(targetHome, restored.map((record) => record.id));
    }

    return {
      manifest,
      mode,
      restored,
      skipped,
      attachments: attachmentSummary,
      workspace: workspaceSummary,
      settings: settingsCount,
      missingWorkspaces: [...missingWorkspaces],
      dryRun: Boolean(options.dryRun),
    };
  } finally {
    backup.close();
  }
}

function attachmentDigestFromName(name) {
  const match = /^(?:sha256:)?([a-f0-9]{64})(?:\.[A-Za-z0-9]+)?$/.exec(name);
  return match ? match[1] : null;
}

function collectAttachmentRefs(text, images, files) {
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'image' && value.attachment && typeof value.attachment === 'object') {
      const id = String(value.attachment.attachmentId ?? '');
      const digest = attachmentDigestFromName(id);
      if (digest) images.set(digest, value.attachment);
    }
    if (value.type === 'file' && value.attachment && typeof value.attachment === 'object') {
      const id = String(value.attachment.attachmentId ?? '');
      const digest = attachmentDigestFromName(id);
      if (digest && typeof value.attachment.name === 'string') files.set(`${digest}\0${value.attachment.name}`, value.attachment);
    }
    for (const item of Object.values(value)) visit(item);
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { visit(JSON.parse(line)); } catch {}
  }
}

function writeImageObject(home, digest, data) {
  const target = path.join(home, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest);
  if (fs.existsSync(target)) return false;
  writeFileAtomic(target, data, 0o444);
  return true;
}

function writeFileObject(home, digest, name, data) {
  const root = path.join(home, 'attachments', 'v1');
  const canonical = path.join(root, 'file-objects', digest.slice(0, 2), digest);
  const alias = path.join(root, 'files', digest.slice(0, 2), digest, name);
  let changed = false;
  if (!fs.existsSync(canonical)) {
    writeFileAtomic(canonical, data, 0o444);
    changed = true;
  }
  if (!fs.existsSync(alias)) {
    writeFileAtomic(alias, data, 0o444);
    changed = true;
  }
  return changed;
}

function safeLeafName(value) {
  let clean = String(value ?? 'file').slice(Math.max(String(value).lastIndexOf('/'), String(value).lastIndexOf('\\')) + 1);
  clean = clean.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim().replace(/[. ]+$/u, '');
  if (clean === '' || clean === '.' || clean === '..') clean = 'file';
  return clean;
}

function writeImportAttachments(zip, home, texts, options) {
  const images = new Map();
  const files = new Map();
  for (const text of texts) collectAttachmentRefs(text, images, files);
  let restored = 0;
  const warnings = [];

  for (const [digest, ref] of images) {
    const entry = zip.entries.find((candidate) => /^media\//.test(candidate.name) && attachmentDigestFromName(path.basename(candidate.name)) === digest);
    if (!entry) { warnings.push(`缺少图片附件：${ref.attachmentId}`); continue; }
    const data = zip.read(entry);
    if (sha256(data) !== digest) { warnings.push(`图片附件校验失败：${entry.name}`); continue; }
    if (!options.dryRun && writeImageObject(home, digest, data)) restored++;
  }

  for (const [key, ref] of files) {
    const [digest] = key.split('\0');
    const entry = zip.entries.find((candidate) => candidate.name.startsWith(`files/${digest.slice(0, 2)}/${digest}/`));
    if (!entry) { warnings.push(`缺少文件附件：${ref.name}`); continue; }
    const data = zip.read(entry);
    if (sha256(data) !== digest) { warnings.push(`文件附件校验失败：${entry.name}`); continue; }
    const name = safeLeafName(ref.name);
    if (!options.dryRun && writeFileObject(home, digest, name, data)) restored++;
  }

  // Unreferenced entries still belong to the archive; restore them as best effort.
  for (const entry of zip.entries) {
    if (entry.name.startsWith('media/')) {
      const digest = attachmentDigestFromName(path.basename(entry.name));
      if (!digest || images.has(digest)) continue;
      const data = zip.read(entry);
      if (sha256(data) === digest && !options.dryRun && writeImageObject(home, digest, data)) restored++;
    } else if (entry.name.startsWith('files/')) {
      const match = /^files\/([a-f0-9]{2})\/([a-f0-9]{64})\/(.+)$/.exec(entry.name);
      if (!match) continue;
      const [, , digest, name] = match;
      if (files.has(`${digest}\0${name}`)) continue;
      const data = zip.read(entry);
      if (sha256(data) === digest && !options.dryRun && writeFileObject(home, digest, safeLeafName(name), data)) restored++;
    }
  }

  return { restored, warnings };
}

/**
 * Import one or more DSH `/export` ZIP archives (single session + descendants + attachments).
 * @returns {object} summary
 */
export function importExportZip(zipPath, home, options = {}) {
  const zip = new ZipReader(zipPath);
  try {
    if (zip.has('manifest.json')) {
      zip.close();
      return { kind: 'backup', ...restoreBackup(zipPath, home, options) };
    }
    if (isDshRunning() && !options.force) {
      throw new Error(
        '检测到 DeepSeek Harness 正在运行。\n' +
          '导入会话后需要重启 DSH 才会重新分组显示。请先完全退出 DSH，再运行导入。\n' +
          '如果只想先放入文件、稍后重启，可加 --force。',
      );
    }

    const rootCandidates = zip.entries
      .filter((entry) => /(^|\/)session(?:\.v\d+)?\.jsonl$/.test(entry.name) && !entry.name.startsWith('subagents/'))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.localeCompare(b.name));
    if (rootCandidates.length === 0) {
      throw new Error('ZIP 中找不到 session.vN.jsonl。\n请确认这是 DSH 会话头部菜单“下载 Session 日志”或 /export 生成的包。');
    }
    const rootEntry = rootCandidates[0];
    const rootText = zip.readText(rootEntry);
    const root = parseSessionJsonl(rootText);
    const targetHome = path.resolve(home);
    const mapper = buildPathMapper({
      manifestHome: options.sourceHome,
      targetHome,
      maps: options.map ?? [],
    });
    let defaultCwd = options.workspace || mapper.map(root.header.cwd) || root.header.cwd;
    if (!defaultCwd) defaultCwd = findDefaultWorkspacePath(targetHome);
    if (!pathExistsDirectory(defaultCwd)) {
      const explicitlyChosen = options.workspace && path.resolve(defaultCwd).toLowerCase() === path.resolve(options.workspace).toLowerCase();
      if (!explicitlyChosen && !options.createAnywhere && !isSafeCreatePath(defaultCwd, targetHome)) {
        const fallback = findDefaultWorkspacePath(targetHome);
        console.log(`  原工作区不存在且不在当前用户目录：${defaultCwd}`);
        console.log(`  改用默认工作区：${fallback}`);
        defaultCwd = fallback;
      }
      if (!options.dryRun) {
        try {
          ensureDir(defaultCwd);
        } catch (error) {
          throw new Error(`无法创建工作区 ${defaultCwd}：${error.message}`);
        }
      }
    }
    if (!path.isAbsolute(defaultCwd)) throw new Error(`目标工作区不是绝对路径：${defaultCwd}`);

    const rootTarget = sessionArtifactPath(targetHome, defaultCwd, root.header.id, root.header.version ?? 4, 'zstd');
    const existingById = new Map(listSessions(targetHome, { withTitles: false }).map((record) => [record.id, record.directory]));
    const rootExisting = existingById.get(root.header.id);
    if (rootExisting) {
      if (!options.overwrite) {
        throw new Error(`目标 DSH 中已经存在同一会话：${root.header.id}\n如需覆盖，请加 --overwrite。`);
      }
      if (!options.dryRun) fs.rmSync(rootExisting, { recursive: true, force: true });
      existingById.delete(root.header.id);
    }
    if (fs.existsSync(rootTarget) && !options.overwrite) {
      throw new Error(`目标 DSH 中已经存在同一会话：${root.header.id}\n如需覆盖，请加 --overwrite。`);
    }
    root.header.cwd = defaultCwd;
    const rootLines = [JSON.stringify(root.header), ...root.eventLines];
    if (!options.dryRun) writeStoredSessionFromJsonl(rootTarget, `${rootLines.join('\n')}\n`);

    const imported = [{ id: root.header.id, cwd: defaultCwd, file: rootTarget, role: 'root' }];
    const skipped = [];
    const texts = [rootText];

    for (const entry of zip.entries) {
      const match = /^subagents\/([^/]+)\/session(?:\.v\d+)?\.jsonl$/.exec(entry.name);
      if (!match) continue;
      const text = zip.readText(entry);
      const parsed = parseSessionJsonl(text);
      let childCwd = options.workspace
        ? defaultCwd
        : (parsed.header.cwd ? (mapper.map(parsed.header.cwd) || defaultCwd) : defaultCwd);
      if (!childCwd || (!pathExistsDirectory(childCwd) && !isSafeCreatePath(childCwd, targetHome))) childCwd = defaultCwd;
      const childTarget = sessionArtifactPath(targetHome, childCwd, parsed.header.id, parsed.header.version ?? 4, 'zstd');
      const childExisting = existingById.get(parsed.header.id);
      if (childExisting) {
        if (!options.overwrite) {
          skipped.push({ id: parsed.header.id, reason: '目标 DSH 已有同一 ID 的子会话' });
          continue;
        }
        if (!options.dryRun) fs.rmSync(childExisting, { recursive: true, force: true });
        existingById.delete(parsed.header.id);
      }
      if (fs.existsSync(childTarget) && !options.overwrite) {
        skipped.push({ id: parsed.header.id, reason: '目标位置已有同名子会话' });
        continue;
      }
      parsed.header.cwd = childCwd;
      if (!options.dryRun) {
        writeStoredSessionFromJsonl(childTarget, `${[JSON.stringify(parsed.header), ...parsed.eventLines].join('\n')}\n`);
      }
      imported.push({ id: parsed.header.id, cwd: childCwd, file: childTarget, role: 'subagent' });
      texts.push(text);
    }

    const attachmentSummary = writeImportAttachments(zip, targetHome, texts, options);
    if (!options.dryRun) {
      detachSessionsFromWorkspaces(targetHome, imported.map((record) => record.id));
      prepareWorkspaceForImport(targetHome);
      clearProjectionCache(targetHome, imported.map((record) => record.id));
    }

    return {
      kind: 'export',
      zip: zipPath,
      restored: imported,
      skipped,
      attachments: attachmentSummary,
      workspace: defaultCwd,
      dryRun: Boolean(options.dryRun),
    };
  } finally {
    zip.close();
  }
}
