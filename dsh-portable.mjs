#!/usr/bin/env node
// DSH 对话数据便携工具 — backup / restore / import for DeepSeek Harness.
// Usage: node dsh-portable.mjs [command] [options]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  BACKUP_FORMAT,
  TOOL_VERSION,
  createBackup,
  formatBytes,
  formatTime,
  importExportZip,
  isDshRunning,
  openBackup,
  restoreBackup,
} from './lib/backup.mjs';
import { findDefaultWorkspacePath, listSessions } from './lib/session.mjs';

const STAMP = () => {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

function resolveHome(explicit) {
  const value = explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.resolve(value);
}

function parseArgs(argv) {
  const result = { _: [], map: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const equals = key.indexOf('=');
    if (equals >= 0) {
      value = key.slice(equals + 1);
      key = key.slice(0, equals);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    } else {
      value = true;
    }
    if (key === 'map') result.map.push(value);
    else result[key] = value;
  }
  return result;
}

function banner() {
  console.log('');
  console.log('  DSH 对话数据便携工具  v' + TOOL_VERSION);
  console.log('  备份 / 恢复 / 导入 DeepSeek Harness 对话');
  console.log('');
}

function printHelp() {
  banner();
  console.log('用法：');
  console.log('  node dsh-portable.mjs                        打开中文菜单');
  console.log('  node dsh-portable.mjs list                   查看本机已存会话');
  console.log('  node dsh-portable.mjs backup [选项]          备份到文件夹');
  console.log('  node dsh-portable.mjs backup --zip [选项]    备份为 ZIP');
  console.log('  node dsh-portable.mjs inspect <备份>         查看备份内容');
  console.log('  node dsh-portable.mjs restore <备份> [选项]  恢复整库备份');
  console.log('  node dsh-portable.mjs import <ZIP...> [选项] 导入 /export 会话包');
  console.log('');
  console.log('通用选项：');
  console.log('  --home <路径>        DSH 数据目录（默认 $DSH_HOME 或 ~/.dsh）');
  console.log('');
  console.log('backup 选项：');
  console.log('  --out <路径>         输出文件夹或 .zip');
  console.log('  --zip                输出 ZIP');
  console.log('  --settings           同时备份 profiles/（插件与设置）');
  console.log('  --credentials        同时备份 .credentials.yaml（敏感）');
  console.log('  --force              DSH 运行中或输出已存在时仍然继续');
  console.log('');
  console.log('restore 选项：');
  console.log('  --mode merge|replace 合并（默认）或替换现有 sessions');
  console.log('  --workspace <路径>   把找不到的工作区统一迁到这里');
  console.log('  --force-workspace    强制所有会话都使用 --workspace');
  console.log('  --map 旧=新          路径映射，可重复');
  console.log('  --settings           恢复 profiles/');
  console.log('  --credentials        恢复 .credentials.yaml');
  console.log('  --overwrite          覆盖同名会话');
  console.log('  --create-anywhere    允许在用户目录之外创建工作区');
  console.log('  --dry-run            只演练，不写文件');
  console.log('  --force              DSH 运行中仍然写入（不推荐）');
  console.log('');
  console.log('import 选项：');
  console.log('  --workspace <路径>   导入到指定工作区（默认沿用原 cwd）');
  console.log('  --map 旧=新          路径映射，可重复');
  console.log('  --overwrite          覆盖同名会话');
  console.log('  --create-anywhere    允许在用户目录之外创建工作区');
  console.log('  --dry-run            只演练，不写文件');
  console.log('  --force              DSH 运行中仍然写入（重启后生效）');
  console.log('');
  console.log('示例：');
  console.log('  dsh-portable.cmd backup --zip --out E:\\DSH备份\\dsh-2026-10-18.zip');
  console.log('  dsh-portable.cmd restore E:\\DSH备份\\dsh-2026-10-18.zip');
  console.log('  dsh-portable.cmd import "C:\\Users\\me\\Downloads\\dsh-session-xxx.zip"');
  console.log('');
}

function printStatus(home) {
  const running = isDshRunning();
  console.log(`DSH 数据目录：${home}`);
  console.log(`DSH 进程：${running ? '正在运行（修改 workspace 前请先完全退出）' : '未检测到'}`);
  console.log('');
}

function shortId(id) {
  if (typeof id !== 'string') return '';
  return id.length > 26 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id;
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function printSessions(records) {
  if (records.length === 0) {
    console.log('没有找到已保存的会话。');
    return;
  }
  console.log(`共 ${records.length} 个会话：`);
  console.log('');
  for (const record of records) {
    const title = record.title ? truncate(record.title, 36) : '(未命名)';
    const cwd = truncate(record.cwd ?? '(无工作区)', 52);
    const size = formatBytes(record.bytes);
    console.log(`  ${formatTime(record.createdAt)}  ${shortId(record.id)}  ${size}`);
    console.log(`    标题：${title}`);
    console.log(`    工作区：${cwd}`);
    if (record.error) console.log(`    状态：读取失败 — ${record.error}`);
    console.log('');
  }
}

function printBackupManifest(manifest) {
  console.log(`备份格式：${manifest.format} v${manifest.formatVersion}`);
  console.log(`创建时间：${formatTime(manifest.createdAt)}`);
  console.log(`来源目录：${manifest.source?.dshHome ?? '未知'}`);
  console.log(`来源电脑：${manifest.source?.hostname ?? '未知'} / ${manifest.source?.username ?? '未知'}`);
  console.log(`会话数量：${manifest.sessions?.length ?? 0}`);
  console.log(`包含设置：${manifest.options?.settings ? '是' : '否'}`);
  console.log(`包含登录凭据：${manifest.options?.credentials ? '是（敏感）' : '否'}`);
  if (manifest.hotBackup) console.log('注意：这是一次热备份（创建时 DSH 仍在运行）。');
  console.log('');
  for (const session of manifest.sessions ?? []) {
    console.log(`  ${shortId(session.id)}  ${session.title ? truncate(session.title, 40) : '(未命名)'}`);
    console.log(`    ${truncate(session.cwd ?? '(无工作区)', 80)}  ${formatBytes(session.bytes ?? 0)}`);
  }
  console.log('');
}

function confirmOrExit(message) {
  console.log(message);
}

function makeOutput(args, zip) {
  if (args.out) return path.resolve(String(args.out));
  return path.resolve(`dsh-backup-${STAMP()}${zip ? '.zip' : ''}`);
}

async function runBackup(args, home) {
  const zip = Boolean(args.zip) || String(args.out ?? '').toLowerCase().endsWith('.zip');
  const output = makeOutput(args, zip);
  printStatus(home);
  console.log(`将备份到：${output}`);
  if (!args.force) {
    console.log('提示：为了完整一致，请先完全退出 DSH；如果现在继续，会做热备份。');
  }
  const result = createBackup(home, output, {
    zip,
    settings: Boolean(args.settings),
    credentials: Boolean(args.credentials),
    force: Boolean(args.force),
    onProgress: (message) => console.log(message),
  });
  console.log('');
  console.log('备份完成。');
  console.log(`  文件：${result.output}`);
  console.log(`  会话：${result.manifest.sessions.length}`);
  console.log(`  大小：${formatBytes(result.bytes)}`);
  if (result.manifest.hotBackup) console.log('  注意：这是热备份；当前会话最后几条消息可能未落盘。');
}

async function runRestore(args, home) {
  const input = args._[1];
  if (!input) throw new Error('请指定备份文件夹或 ZIP，例如：restore E:\\DSH备份\\dsh-2026-10-18.zip');
  const manifest = openBackup(input).manifest;
  printBackupManifest(manifest);
  printStatus(home);
  const mode = args.mode === 'replace' ? 'replace' : 'merge';
  console.log(`恢复模式：${mode === 'replace' ? '替换现有 sessions（会先改名备份）' : '合并（保留现有会话）'}`);
  console.log(`目标目录：${home}`);
  if (!args['dry-run'] && !args.force && isDshRunning()) {
    throw new Error('请先完全退出 DSH，再运行恢复。若只想演练，请加 --dry-run。');
  }
  const result = restoreBackup(input, home, {
    mode,
    map: args.map ?? [],
    workspace: args.workspace,
    forceWorkspace: Boolean(args['force-workspace']),
    settings: Boolean(args.settings),
    credentials: Boolean(args.credentials),
    overwrite: Boolean(args.overwrite),
    dryRun: Boolean(args['dry-run']),
    force: Boolean(args.force),
    createWorkspaces: args['no-create-workspaces'] ? false : true,
    createAnywhere: Boolean(args['create-anywhere']),
  });
  console.log('');
  console.log(result.dryRun ? '演练完成（未写入任何文件）。' : '恢复完成。');
  console.log(`  恢复会话：${result.restored.length}`);
  console.log(`  跳过：${result.skipped.length}`);
  for (const item of result.skipped.slice(0, 20)) console.log(`    - ${item.id}：${item.reason}`);
  if (result.skipped.length > 20) console.log(`    ... 另有 ${result.skipped.length - 20} 条`);
  console.log(`  附件：新增 ${result.attachments.restored}，已存在 ${result.attachments.skipped}`);
  console.log(`  工作区记录：${result.workspace}`);
  if (result.settings) console.log(`  设置文件：${result.settings} 个`);
  if (result.missingWorkspaces.length > 0) {
    console.log('  以下工作区目录不存在，已跳过相关会话：');
    for (const item of result.missingWorkspaces) console.log(`    - ${item}`);
  }
  console.log('');
  if (!result.dryRun) console.log('现在重新启动 DSH 即可在侧边栏看到恢复的会话。');
}

async function runImport(args, home) {
  const inputs = args._.slice(1);
  if (inputs.length === 0) throw new Error('请指定一个或多个 /export 生成的 ZIP 文件。');
  printStatus(home);
  let total = 0;
  for (const input of inputs) {
    const file = path.resolve(input);
    if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
    console.log(`正在导入：${file}`);
    const result = importExportZip(file, home, {
      workspace: args.workspace,
      map: args.map ?? [],
      overwrite: Boolean(args.overwrite),
      dryRun: Boolean(args['dry-run']),
      force: Boolean(args.force),
      createAnywhere: Boolean(args['create-anywhere']),
    });
    total += result.restored.length;
    console.log(`  会话：${result.restored.length}，跳过：${result.skipped.length}`);
    for (const item of result.skipped.slice(0, 10)) console.log(`    - ${item.id}：${item.reason}`);
    console.log(`  附件：新增 ${result.attachments.restored}`);
    for (const warning of result.attachments.warnings.slice(0, 10)) console.log(`    ! ${warning}`);
    console.log(`  目标工作区：${result.workspace}`);
  }
  console.log('');
  console.log(`导入完成，共处理 ${total} 个会话。重新启动 DSH 后生效。`);
}

function runList(args, home) {
  printStatus(home);
  const records = listSessions(home, { withTitles: true });
  printSessions(records);
}

function runInspect(args) {
  const input = args._[1];
  if (!input) throw new Error('请指定备份文件夹或 ZIP。');
  const backup = openBackup(input);
  try {
    printBackupManifest(backup.manifest);
    const attachments = backup.list('attachments/v1');
    console.log(`附件文件：${attachments.length}`);
  } finally {
    backup.close();
  }
}

function portableInfo(home) {
  banner();
  console.log('方案一：让 DSH 把所有数据直接存到 U 盘（最小改动）');
  console.log('');
  console.log('  1. 退出 DSH（托盘图标 → 退出）。');
  console.log('  2. 在 U 盘建一个文件夹，例如 E:\\DSH-Portable。');
  console.log('  3. 在 Windows“系统属性 → 环境变量”里新建用户变量：');
  console.log('       DSH_HOME = E:\\DSH-Portable');
  console.log('     或者在命令提示符执行：');
  console.log('       setx DSH_HOME "E:\\DSH-Portable"');
  console.log('  4. 重新启动 DSH。之后所有会话、附件、设置都会写到这个文件夹。');
  console.log('');
  console.log('  换电脑时：安装 DSH → 插上 U 盘 → 设置同样的 DSH_HOME → 启动。');
  console.log('');
  console.log('  注意：');
  console.log('  - 盘符变化（E: 变成 F:）时要同步改 DSH_HOME。');
  console.log('  - 不要在使用中直接拔 U 盘；先退出 DSH。');
  console.log('  - 不建议把 DSH_HOME 指向 OneDrive/坚果云等实时同步目录，');
  console.log('    多端同时写同一份会话可能冲突；请用“备份到云盘”而不是“实时同步”。');
  console.log('');
  console.log(`当前程序看到的 DSH_HOME：${home}`);
  console.log('如果这个路径还不是 U 盘，说明环境变量尚未生效。');
  console.log('');
  console.log('方案二：官方 /export + 本工具 import（适合只迁移部分会话）');
  console.log('  在 DSH 会话头部“更多操作”里选“下载 Session 日志”，或输入 /export，');
  console.log('  再把 ZIP 拷到新电脑，运行：dsh-portable.cmd import <zip>');
  console.log('');
  console.log('方案三：整库备份 + 恢复（最完整，推荐换电脑/重装系统用）');
  console.log('  旧电脑：dsh-portable.cmd backup --zip --settings');
  console.log('  新电脑：先装 DSH，先不要打开；运行');
  console.log('          dsh-portable.cmd restore <备份.zip> --settings');
  console.log('');
}

async function askText(rl, question, defaultValue = '') {
  const suffix = defaultValue ? `（默认 ${defaultValue}）` : '';
  const answer = (await rl.question(`${question}${suffix}：`)).trim();
  return answer || defaultValue;
}

async function askYesNo(rl, question, defaultValue = true) {
  const answer = (await rl.question(`${question} [${defaultValue ? 'Y/n' : 'y/N'}]：`)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes' || answer === '是';
}

async function menu(home) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      banner();
      printStatus(home);
      console.log('  1. 备份到 U 盘/文件夹');
      console.log('  2. 备份为 ZIP（适合上传云盘）');
      console.log('  3. 查看本机已存会话');
      console.log('  4. 从整库备份恢复（换电脑/重装系统）');
      console.log('  5. 导入官方 /export 会话 ZIP');
      console.log('  6. 查看“直接把数据存 U 盘”的便携模式说明');
      console.log('  0. 退出');
      console.log('');
      const choice = await askText(rl, '请选择', '0');
      try {
        if (choice === '1' || choice === '2') {
          const zip = choice === '2';
          const defaultOut = path.resolve(`dsh-backup-${STAMP()}${zip ? '.zip' : ''}`);
          const out = await askText(rl, '输出路径', defaultOut);
          const settings = await askYesNo(rl, '同时备份设置（profiles，不含登录凭据）', true);
          if (isDshRunning()) {
            console.log('检测到 DSH 正在运行。建议先完全退出；现在继续会做热备份。');
            const go = await askYesNo(rl, '仍然继续热备份吗', false);
            if (!go) continue;
          }
          const result = createBackup(home, out, {
            zip,
            settings,
            force: true,
            onProgress: (message) => console.log(message),
          });
          console.log('');
          console.log(`完成：${result.output}`);
          console.log(`会话 ${result.manifest.sessions.length} 个，大小 ${formatBytes(result.bytes)}`);
        } else if (choice === '3') {
          printSessions(listSessions(home, { withTitles: true }));
        } else if (choice === '4') {
          const input = await askText(rl, '备份路径（文件夹或 ZIP）');
          if (!input) continue;
          const manifest = openBackup(input).manifest;
          printBackupManifest(manifest);
          const mode = (await askText(rl, '恢复模式 merge=合并 / replace=替换', 'merge')).toLowerCase();
          const workspace = await askText(rl, '统一目标工作区（留空=沿用原路径）', '');
          const settings = await askYesNo(rl, '恢复设置（profiles）', true);
          if (isDshRunning()) {
            console.log('DSH 正在运行，恢复前必须先完全退出。');
            const go = await askYesNo(rl, '已经退出 DSH，继续吗', false);
            if (!go) continue;
          }
          const result = restoreBackup(input, home, {
            mode: mode === 'replace' ? 'replace' : 'merge',
            settings,
            workspace: workspace || undefined,
            force: true,
          });
          console.log('');
          console.log(`恢复会话 ${result.restored.length} 个，跳过 ${result.skipped.length} 个。`);
          console.log('重新启动 DSH 后生效。');
        } else if (choice === '5') {
          const input = await askText(rl, '会话 ZIP 路径');
          if (!input) continue;
          const defaultWorkspace = findDefaultWorkspacePath(home);
          const workspace = await askText(rl, '目标工作区', defaultWorkspace);
          if (isDshRunning()) {
            console.log('DSH 正在运行：文件会先写入，但需要重启 DSH 才会重新分组显示。');
            const go = await askYesNo(rl, '继续吗', true);
            if (!go) continue;
          }
          const result = importExportZip(input, home, { workspace, force: true });
          console.log('');
          console.log(`导入会话 ${result.restored.length} 个，附件 ${result.attachments.restored} 个。`);
          console.log('重新启动 DSH 后生效。');
        } else if (choice === '6') {
          portableInfo(home);
        } else if (choice === '0') {
          return;
        }
      } catch (error) {
        console.log('');
        console.log(`错误：${error.message}`);
      }
      console.log('');
      await rl.question('按回车返回菜单…');
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 15)) {
    throw new Error(`需要 Node.js 22.15 或更高版本（当前 ${process.versions.node}）。请使用 DSH 自带的运行时，或安装新版 Node.js。`);
  }
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'menu';
  const home = resolveHome(args.home ? String(args.home) : undefined);
  if (command === 'menu' || command === '') {
    await menu(home);
    return;
  }
  if (command === 'help' || args.help) {
    printHelp();
    return;
  }
  if (command === 'list') {
    runList(args, home);
    return;
  }
  if (command === 'backup') {
    await runBackup(args, home);
    return;
  }
  if (command === 'inspect') {
    runInspect(args);
    return;
  }
  if (command === 'restore') {
    await runRestore(args, home);
    return;
  }
  if (command === 'import') {
    await runImport(args, home);
    return;
  }
  if (command === 'portable') {
    portableInfo(home);
    return;
  }
  console.log(`未知命令：${command}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.log('');
  console.log(`错误：${error.message}`);
  if (process.env.DSH_PORTABLE_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
