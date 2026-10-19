// Scan local disks for dsh-portable backups.
// A backup is recognized by manifest.json (format = dsh-portable-backup)
// plus a sibling `data/` directory. Full absolute paths are kept so the
// caller can restore directly from the found folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKUP_FORMAT, openBackup } from './backup.mjs';
import { listWindowsDrives } from './usb.mjs';

const SKIP_DIRS = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
  '.svn',
  'appdata',
  'data',
  'sessions',
  'attachments',
  'profiles',
  'cache',
  'dsh-runtimes',
  'speech-to-text',
  '__pycache__',
]);

const BACKUP_NAME_RE = /(dsh.?backup|dsh.?备份|dsH备份|备份)/i;
const BACKUP_ZIP_RE = /^(dsh.?backup|dsh.?备份|DSH备份).*\.zip$/i;

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function isFile(value) {
  try { return fs.statSync(value).isFile(); } catch { return false; }
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name.toLowerCase());
}

function readFolderCandidate(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  const dataPath = path.join(directory, 'data');
  if (!isFile(manifestPath) || !isDirectory(dataPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    if (manifest?.format !== BACKUP_FORMAT) return null;
    const stat = fs.statSync(manifestPath);
    return {
      kind: 'dir',
      path: directory,
      manifestPath,
      manifest,
      sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
      createdAt: manifest.createdAt ?? stat.mtime.toISOString(),
      sourceHome: manifest.source?.dshHome ?? '',
      settings: Boolean(manifest.options?.settings),
      hotBackup: Boolean(manifest.hotBackup),
      mtime: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function readZipCandidate(file) {
  if (!BACKUP_ZIP_RE.test(path.basename(file))) return null;
  let backup;
  try {
    backup = openBackup(file);
    const manifest = backup.manifest;
    const stat = fs.statSync(file);
    return {
      kind: 'zip',
      path: file,
      manifestPath: `${file}!/manifest.json`,
      manifest,
      sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
      createdAt: manifest.createdAt ?? stat.mtime.toISOString(),
      sourceHome: manifest.source?.dshHome ?? '',
      settings: Boolean(manifest.options?.settings),
      hotBackup: Boolean(manifest.hotBackup),
      mtime: stat.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    backup?.close();
  }
}

function listEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(directory, depth, maxDepth, context) {
  const real = path.resolve(directory);
  if (context.visited.has(real)) return;
  context.visited.add(real);
  context.scannedDirs++;

  const folder = readFolderCandidate(directory);
  if (folder) {
    context.candidates.push(folder);
    // A backup folder contains data/sessions/attachments; do not descend into
    // those huge trees. Nested backups are unusual, so stop here.
    return;
  }

  const entries = listEntries(directory);
  for (const entry of entries) {
    if (entry.isFile() && BACKUP_ZIP_RE.test(entry.name)) {
      const candidate = readZipCandidate(path.join(directory, entry.name));
      if (candidate) context.candidates.push(candidate);
    }
  }

  if (depth >= maxDepth) return;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (shouldSkipDir(entry.name)) continue;
    const next = path.join(directory, entry.name);
    const namedLikeBackup = BACKUP_NAME_RE.test(entry.name);
    walk(next, depth + 1, namedLikeBackup ? maxDepth + 2 : maxDepth, context);
  }
}

function commonRoots() {
  const roots = [];
  const add = (value, depth) => {
    if (value && isDirectory(value)) roots.push({ path: value, depth });
  };
  const home = os.homedir();
  add(home, 1);
  add(path.join(home, 'Desktop'), 4);
  add(path.join(home, 'Documents'), 4);
  add(path.join(home, 'Downloads'), 4);
  add(path.join(home, 'OneDrive'), 3);
  add(path.join(home, 'OneDrive', 'Desktop'), 4);
  add(path.join(home, 'OneDrive', 'Documents'), 4);
  add(process.cwd(), 3);
  return roots;
}

/**
 * Scan all local logical disks and common user folders for dsh-portable backups.
 * @returns {{candidates: object[], scannedDirs: number, roots: string[]}}
 */
export function scanForBackups(options = {}) {
  const drives = listWindowsDrives();
  const roots = [];
  const addRoot = (value, depth) => {
    if (!value || !isDirectory(value)) return;
    if (roots.some((root) => path.resolve(root.path).toLowerCase() === path.resolve(value).toLowerCase())) return;
    roots.push({ path: value, depth });
  };

  for (const drive of drives) {
    const root = `${drive.deviceId}\\`;
    addRoot(root, 2);
    // Root-level folders with backup-ish names are the primary USB/custom target.
    for (const entry of listEntries(root)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (BACKUP_NAME_RE.test(entry.name)) addRoot(path.join(root, entry.name), 6);
    }
    // Common user folders on every drive (including C:).
    const users = path.join(root, 'Users');
    if (isDirectory(users)) {
      for (const user of listEntries(users)) {
        if (!user.isDirectory() || user.isSymbolicLink()) continue;
        const userRoot = path.join(users, user.name);
        addRoot(userRoot, 1);
        for (const sub of ['Desktop', 'Documents', 'Downloads', 'OneDrive']) {
          addRoot(path.join(userRoot, sub), 4);
        }
      }
    }
  }
  for (const root of commonRoots()) addRoot(root.path, root.depth);

  const context = { candidates: [], visited: new Set(), scannedDirs: 0 };
  for (const root of roots) {
    options.onProgress?.(`正在搜索：${root.path}`);
    walk(root.path, 0, root.depth, context);
  }

  const seen = new Set();
  const candidates = [];
  for (const candidate of context.candidates) {
    const key = path.resolve(candidate.path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt) || left.mtime || 0;
    const rightTime = Date.parse(right.createdAt) || right.mtime || 0;
    return rightTime - leftTime;
  });
  return { candidates, scannedDirs: context.scannedDirs, roots: roots.map((root) => root.path) };
}
