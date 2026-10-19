// Windows removable-drive discovery for the "backup to USB" flow.
// Uses PowerShell's Win32_LogicalDisk view; no third-party dependency.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function formatSize(value) {
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

/** List local logical disks. Removable drives sort first. */
export function listWindowsDrives() {
  if (process.platform !== 'win32') return [];
  const command = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    'Get-CimInstance Win32_LogicalDisk',
    '| Select-Object DeviceID,DriveType,VolumeName,Size,FreeSpace',
    '| ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((item) => item && typeof item.DeviceID === 'string' && Number(item.Size) > 0)
      .map((item) => ({
        deviceId: item.DeviceID.toUpperCase(),
        letter: item.DeviceID.replace(':', '').toUpperCase(),
        type: Number(item.DriveType) || 0,
        removable: Number(item.DriveType) === 2,
        volumeName: typeof item.VolumeName === 'string' ? item.VolumeName : '',
        size: Number(item.Size) || 0,
        free: Number(item.FreeSpace) || 0,
      }))
      .sort((left, right) => Number(right.removable) - Number(left.removable) || left.letter.localeCompare(right.letter));
  } catch {
    return [];
  }
}

export function describeDrive(drive) {
  const name = drive.volumeName ? ` ${drive.volumeName}` : '';
  const kind = drive.removable ? '可移动磁盘' : '本地磁盘';
  return `${drive.deviceId}${name}  ${kind}  可用 ${formatSize(drive.free)} / ${formatSize(drive.size)}`;
}

/** Find the requested drive, or the first removable drive with enough free space. */
export function selectDrive(explicitLetter) {
  const drives = listWindowsDrives();
  if (drives.length === 0) {
    throw new Error('没有检测到可用磁盘。请确认 U 盘已插好，或用 --out 手动指定保存路径。');
  }
  if (explicitLetter) {
    const letter = String(explicitLetter).replace(/[:\\/]/g, '').toUpperCase();
    const found = drives.find((drive) => drive.letter === letter);
    if (!found) throw new Error(`没有找到磁盘 ${letter}:。可用磁盘：${drives.map((drive) => drive.deviceId).join('、')}`);
    return found;
  }
  const removable = drives.find((drive) => drive.removable && drive.free > 100 * 1024 * 1024);
  if (!removable) {
    throw new Error(
      '没有检测到可移动 U 盘（或可用空间不足 100 MB）。\n' +
        '可以插好 U 盘后重试，或用 --drive E: 指定磁盘，或用 --out 手动指定路径。',
    );
  }
  return removable;
}

/** Create (or reuse) <drive>:\DSH备份 and return its absolute path. */
export function createBackupFolder(drive, folderName = 'DSH备份') {
  if (!drive || typeof drive.deviceId !== 'string') throw new Error('无效的磁盘');
  const root = path.join(`${drive.deviceId}\\`, folderName);
  fs.mkdirSync(root, { recursive: true });
  return root;
}
