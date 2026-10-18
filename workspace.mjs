// Workspace registry (storages/workspace.json) transformations.
// DSH bootstraps missing sessions into workspaces whenever `initialized` is false,
// so imports only need to stage session files and flip that marker.
import fs from 'node:fs';
import path from 'node:path';
import { minimalWorkspaceState, randomWorkspaceId, readWorkspaceState } from './session.mjs';

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function writeWorkspaceState(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

/** Remove session ids from every workspace record so a later bootstrap can re-own them. */
export function detachSessionsFromWorkspaces(home, ids) {
  const set = new Set(ids);
  if (set.size === 0) return 0;
  const { file, data } = readWorkspaceState(home);
  if (!data) return 0;
  let changed = 0;
  for (const record of Object.values(data.tables?.workspaces ?? {})) {
    const before = record.sessionIds?.length ?? 0;
    record.sessionIds = (record.sessionIds ?? []).filter((id) => !set.has(id));
    if (record.sessionIds.length !== before) changed += before - record.sessionIds.length;
  }
  if (changed > 0) writeWorkspaceState(file, data);
  return changed;
}

/** Ensure a usable workspace registry exists and force a header re-index on next start. */
export function prepareWorkspaceForImport(home, options = {}) {
  const { file, data } = readWorkspaceState(home);
  if (!data) {
    if (fs.existsSync(file) && options.backupCorrupt !== false) {
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    }
    const minimal = minimalWorkspaceState();
    writeWorkspaceState(file, minimal);
    return { file, data: minimal, created: true };
  }
  const state = data.global ?? (data.global = {});
  state.initialized = false;
  if (!Array.isArray(state.workspaceIds)) state.workspaceIds = [];
  if (!Array.isArray(state.archivedSessionIds)) state.archivedSessionIds = [];
  if (!Array.isArray(state.pinnedSessionIds)) state.pinnedSessionIds = [];
  if (!data.tables) data.tables = {};
  if (!data.tables.workspaces) data.tables.workspaces = {};
  writeWorkspaceState(file, data);
  return { file, data, created: false };
}

/** Rewrite workspace paths through a path mapper and merge records that collapse together. */
export function transformWorkspacePaths(raw, mapper) {
  const data = structuredClone(raw);
  const state = data.global ?? (data.global = {});
  const records = data.tables?.workspaces ?? (data.tables = { ...(data.tables ?? {}), workspaces: {} }).workspaces;
  const order = Array.isArray(state.workspaceIds) ? state.workspaceIds : [];
  const byPath = new Map();
  const newOrder = [];
  const idRemap = new Map();

  const mergeInto = (targetId, record) => {
    const target = records[targetId];
    target.sessionIds = unique([...(target.sessionIds ?? []), ...(record.sessionIds ?? [])]);
    if (Date.parse(record.updatedAt) > Date.parse(target.updatedAt)) target.updatedAt = record.updatedAt;
  };

  for (const oldId of order) {
    const record = records[oldId];
    if (!record || typeof record.path !== 'string') continue;
    const newPath = mapper.map(record.path);
    const key = newPath.replace(/\//g, '\\').toLowerCase();
    if (byPath.has(key)) {
      mergeInto(byPath.get(key), record);
      idRemap.set(oldId, byPath.get(key));
      continue;
    }
    const copy = { ...record, path: newPath, sessionIds: unique(record.sessionIds) };
    records[oldId] = copy;
    byPath.set(key, oldId);
    newOrder.push(oldId);
    idRemap.set(oldId, oldId);
  }

  // Records that exist in the table but were absent from the ordered list:
  // keep them rather than silently dropping user data.
  for (const oldId of Object.keys(records)) {
    if (idRemap.has(oldId)) continue;
    const record = records[oldId];
    if (!record || typeof record.path !== 'string') continue;
    const newPath = mapper.map(record.path);
    const key = newPath.replace(/\//g, '\\').toLowerCase();
    if (byPath.has(key)) {
      mergeInto(byPath.get(key), record);
      idRemap.set(oldId, byPath.get(key));
      delete records[oldId];
    } else {
      records[oldId] = { ...record, path: newPath, sessionIds: unique(record.sessionIds) };
      byPath.set(key, oldId);
      newOrder.push(oldId);
      idRemap.set(oldId, oldId);
    }
  }

  state.workspaceIds = newOrder;
  state.initialized = false;
  if (typeof state.defaultWorkspaceId === 'string') {
    const mapped = idRemap.get(state.defaultWorkspaceId);
    if (mapped) state.defaultWorkspaceId = mapped;
    else delete state.defaultWorkspaceId;
  }
  state.archivedSessionIds = unique(state.archivedSessionIds);
  state.pinnedSessionIds = unique(state.pinnedSessionIds);
  return data;
}

/** Merge a transformed backup registry into an existing target registry. */
export function mergeWorkspaceStates(targetRaw, incomingRaw) {
  const target = structuredClone(targetRaw);
  const incoming = structuredClone(incomingRaw);
  const state = target.global ?? (target.global = {});
  const records = target.tables?.workspaces ?? (target.tables = { ...(target.tables ?? {}), workspaces: {} }).workspaces;
  const order = Array.isArray(state.workspaceIds) ? state.workspaceIds : [];
  const byPath = new Map(order.filter((id) => records[id]).map((id) => [records[id].path.replace(/\//g, '\\').toLowerCase(), id]));
  const usedIds = new Set(Object.keys(records));
  const accounted = new Map();
  for (const [id, record] of Object.entries(records)) {
    for (const sessionId of record.sessionIds ?? []) {
      if (!accounted.has(sessionId)) accounted.set(sessionId, id);
    }
  }

  const incomingRecords = incoming.tables?.workspaces ?? {};
  const incomingOrder = incoming.global?.workspaceIds ?? Object.keys(incomingRecords);
  for (const incomingId of incomingOrder) {
    const record = incomingRecords[incomingId];
    if (!record || typeof record.path !== 'string') continue;
    const key = record.path.replace(/\//g, '\\').toLowerCase();
    const targetId = byPath.get(key);
    const allowedIds = unique(record.sessionIds).filter((sessionId) => !accounted.has(sessionId) || accounted.get(sessionId) === targetId);
    if (targetId) {
      records[targetId].sessionIds = unique([...(records[targetId].sessionIds ?? []), ...allowedIds]);
      for (const sessionId of allowedIds) accounted.set(sessionId, targetId);
      continue;
    }
    let id = incomingId;
    if (!id || usedIds.has(id)) id = randomWorkspaceId();
    usedIds.add(id);
    records[id] = { ...record, sessionIds: allowedIds };
    byPath.set(key, id);
    order.push(id);
    for (const sessionId of allowedIds) accounted.set(sessionId, id);
  }

  state.workspaceIds = order;
  state.initialized = false;
  state.archivedSessionIds = unique([...(state.archivedSessionIds ?? []), ...(incoming.global?.archivedSessionIds ?? [])]);
  state.pinnedSessionIds = unique([...(state.pinnedSessionIds ?? []), ...(incoming.global?.pinnedSessionIds ?? [])]);
  if (!state.defaultWorkspaceId && typeof incoming.global?.defaultWorkspaceId === 'string') {
    state.defaultWorkspaceId = incoming.global.defaultWorkspaceId;
  }

  // Preserve incoming table records that were not listed in its order array.
  for (const [incomingId, record] of Object.entries(incomingRecords)) {
    if (!record || typeof record.path !== 'string') continue;
    if (Object.values(records).some((existing) => existing.path === record.path)) continue;
    const allowedIds = unique(record.sessionIds).filter((sessionId) => !accounted.has(sessionId));
    let id = incomingId;
    if (!id || usedIds.has(id)) id = randomWorkspaceId();
    usedIds.add(id);
    records[id] = { ...record, sessionIds: allowedIds };
    order.push(id);
    for (const sessionId of allowedIds) accounted.set(sessionId, id);
  }
  return target;
}
