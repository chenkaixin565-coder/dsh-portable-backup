// Session artifact discovery, path encoding, and workspace-record helpers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readStoredSessionHeader, readStoredSessionText } from './zstd.mjs';

const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

/** DSH's readable project-directory key for a session cwd. */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** DSH's injective single-segment session-id encoding. */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

export function sessionDir(home, cwd, id) {
  return path.join(home, 'sessions', projectKey(cwd), encodeSegment(id));
}

export function sessionArtifactPath(home, cwd, id, version, compression = 'zstd') {
  const base = `session${version >= 1 ? `.v${version}` : ''}.jsonl`;
  return path.join(sessionDir(home, cwd, id), compression === 'zstd' ? `${base}.zstd` : base);
}

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

/** Return the latest stored artifact for one session directory. */
export function pickLatestArtifact(directory) {
  let best = null;
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = SESSION_FILE_RE.exec(name);
    if (!match) continue;
    const version = match[1] === undefined ? 0 : Number(match[1]);
    const compression = match[2] ? 'zstd' : 'none';
    const file = path.join(directory, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    const candidate = { file, version, compression, bytes: stat.size };
    if (
      best === null ||
      candidate.version > best.version ||
      (candidate.version === best.version && candidate.compression === 'zstd' && best.compression !== 'zstd')
    ) best = candidate;
  }
  return best;
}

/** Read only a session's header from the latest artifact in its directory. */
export function readSessionHeaderFromDir(directory) {
  const artifact = pickLatestArtifact(directory);
  if (!artifact) return null;
  try {
    const { header } = readStoredSessionHeader(artifact.file);
    return { ...artifact, header };
  } catch (error) {
    return { ...artifact, error: error.message };
  }
}

/** List every stored session under <home>/sessions. */
export function listSessions(home, options = {}) {
  const root = path.join(home, 'sessions');
  const result = [];
  if (!fs.existsSync(root)) return result;
  for (const projectEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(root, projectEntry.name);
    for (const sessionEntry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue;
      const directory = path.join(projectDir, sessionEntry.name);
      const artifact = readSessionHeaderFromDir(directory);
      if (!artifact) continue;
      const title = options.withTitles === false ? null : readProjectionTitle(home, sessionEntry.name);
      result.push({
        id: artifact.header.id ?? sessionEntry.name,
        cwd: artifact.header.cwd,
        createdAt: artifact.header.createdAt,
        delegationDepth: artifact.header.delegationDepth ?? 0,
        parentSession: artifact.header.parentSession,
        version: artifact.version,
        compression: artifact.compression,
        bytes: artifact.bytes,
        directory,
        file: artifact.file,
        title,
        error: artifact.error,
      });
    }
  }
  result.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return result;
}

export function readProjectionTitle(home, id) {
  const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = data?.record?.rows?.title?.val;
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  } catch {
    return null;
  }
}

/** Derive a human title from the first user message when no projection cache exists. */
export function deriveTitleFromLog(record) {
  try {
    const { text } = readStoredSessionText(record.file);
    for (const line of text.split('\n')) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== 'user/message') continue;
      const content = event?.data?.content;
      if (!Array.isArray(content)) continue;
      const textPart = content.find((part) => part?.type === 'text' && typeof part.text === 'string');
      if (textPart) return textPart.text.replace(/\s+/g, ' ').slice(0, 60);
    }
  } catch {}
  return null;
}

/** Read and lightly validate storages/workspace.json. */
export function readWorkspaceState(home) {
  const file = path.join(home, 'storages', 'workspace.json');
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && data.tables && data.global) return { file, data, exists: true };
  } catch {}
  return { file, data: null, exists: false };
}

export function minimalWorkspaceState() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: false,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces: {} },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function randomWorkspaceId() {
  return randomUUID();
}

export function isWorkspaceId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Default workspace chosen by DSH, read from its own registry when possible. */
export function findDefaultWorkspacePath(home) {
  const { data } = readWorkspaceState(home);
  const records = data?.tables?.workspaces ?? {};
  const preferred = Object.values(records).find(
    (record) => typeof record?.path === 'string' && record.path.replace(/[\\/]+$/, '').toLowerCase().endsWith('default-workspace'),
  );
  if (preferred) return preferred.path;
  const first = Object.values(records).find((record) => typeof record?.path === 'string');
  if (first) return first.path;
  return path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace');
}

export function clearProjectionCache(home, ids) {
  let removed = 0;
  for (const id of ids) {
    const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
    try {
      fs.unlinkSync(file);
      removed++;
    } catch {}
  }
  return removed;
}

/** Build a longest-prefix path mapper (case-insensitive on Windows). */
export function buildPathMapper({ manifestHome, targetHome, maps = [] } = {}) {
  const entries = [];
  const add = (from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string') return;
    const cleanFrom = from.replace(/[\\/]+$/, '');
    const cleanTo = to.replace(/[\\/]+$/, '');
    if (!cleanFrom || !cleanTo || cleanFrom.toLowerCase() === cleanTo.toLowerCase()) return;
    entries.push({ from: cleanFrom, to: cleanTo });
  };
  for (const raw of maps) {
    if (typeof raw !== 'string') continue;
    const index = raw.indexOf('=');
    if (index <= 0) throw new Error(`--map 的格式必须是 旧路径=新路径：${raw}`);
    add(raw.slice(0, index), raw.slice(index + 1));
  }
  if (manifestHome && targetHome) {
    add(manifestHome, targetHome);
    if (path.basename(manifestHome).toLowerCase() === '.dsh') {
      // Session workspaces normally live under the OS user profile, not under
      // the DSH home. Map the old profile to the current one even when DSH_HOME
      // points at a USB drive or another custom directory.
      add(path.dirname(manifestHome), os.homedir());
    }
  }
  entries.sort((a, b) => b.from.length - a.from.length);
  return {
    entries,
    map(value) {
      if (typeof value !== 'string' || value === '') return value;
      const normalized = value.replace(/\//g, '\\');
      for (const entry of entries) {
        const from = entry.from.replace(/\//g, '\\');
        if (normalized.toLowerCase() === from.toLowerCase()) return entry.to;
        if (normalized.toLowerCase().startsWith(`${from.toLowerCase()}\\`)) {
          return `${entry.to}${normalized.slice(from.length)}`;
        }
      }
      return value;
    },
  };
}

export function pathExistsDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}
