# dsh-portable

> 不装插件、不装 Node，双击就能备份 / 恢复 / 迁移 DeepSeek Harness 对话数据的 Windows 小工具。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-1082ff)](https://github.com/deepseek-ai/deepseek-harness)
[![Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)](https://www.microsoft.com/windows)

> 非官方项目，与 DeepSeek 官方无隶属关系。涉及写入 `~/.dsh` 的操作，请先备份、先 `--dry-run`。

📖 **图文版使用指南（19 页，小白照着做）**：[PDF](docs/DSH对话数据备份与迁移指南.pdf) · [Word](docs/DSH对话数据备份与迁移指南.docx)

## 这个工具解决什么问题

DeepSeek Harness（DSH）把对话存在：

```text
%USERPROFILE%\.dsh\
  sessions\        # 每个会话一个 session.vN.jsonl.zstd
  attachments\     # 图片、文件（按 SHA-256 内容寻址）
  storages\        # workspace.json（工作区与会话归属）
  profiles\        # 插件与设置
```

重装系统、换电脑、C 盘被清空，这些数据就没了。官方目前**只有导出、没有导入**，也没有账号级云同步。

`dsh-portable` 提供五件事：

1. **整库备份/恢复**：把 `sessions + attachments + workspace.json` 打成一个文件夹或 ZIP；换机后一键恢复。
2. **一键找 U 盘**：菜单 `7` / `backup --usb` 自动检测可移动磁盘，创建 `<U盘>:\DSH备份` 文件夹并把 ZIP 放进去，不用手动新建。
3. **自动搜索所有盘**：菜单 `8` / `scan` 扫描所有磁盘和常见用户目录，通过 `manifest.json` + `data/` 找到备份，显示完整路径后直接恢复。
4. **导入官方 `/export` 会话包**：官方导出的 ZIP 只能下载、不能导入；本工具可以把它放回 DSH。
5. **路径重映射**：新电脑用户名/盘符变了，自动把会话里的旧 `cwd` 映射到新目录，避免全部变成“未分组”。

它**不是** DSH 插件，不修改 DSH 程序；恢复/导入前要求完全退出 DSH。

## 快速开始

### 1. 备份（旧电脑）

1. 完全退出 DSH（托盘图标 → 退出）。
2. 双击 `dsh-portable.cmd`。
3. 选 `7`：自动检测 U 盘，创建 `DSH备份` 文件夹，把 ZIP 放进去。也可以选 `2` 手动指定路径。
4. 建议选“同时备份设置（profiles）”；**不要**备份登录凭据，除非你清楚风险。

命令行等价：

```bat
dsh-portable.cmd backup --usb --settings
```

如果有多块磁盘，或自动选错了，可以指定盘符：

```bat
dsh-portable.cmd backup --usb --drive E: --settings
```

### 2. 恢复（新电脑）

1. 安装 DSH，**先不要打开**（如果已经打开过也没关系，用默认的 merge 模式）。
2. 把 `dsh-portable` 文件夹和备份 ZIP 拷到新电脑。
3. 双击 `dsh-portable.cmd`，选 `8` 自动搜索所有盘上的备份；也可以选 `4` 手动指定 ZIP。
4. 恢复完成后启动 DSH，侧边栏即可看到会话。

命令行等价：

```bat
dsh-portable.cmd restore --auto --settings
```

`restore --auto` 会自动选择时间最新的备份；想先看找到哪些，用：

```bat
dsh-portable.cmd scan
```

扫描结果会显示每个备份的完整路径、时间、会话数，例如：

```text
E:\DSH备份\DSH备份_20261019-210150.zip
```

**菜单 8 / `scan` 的识别规则：**

- 扫描所有本地磁盘、U 盘，以及桌面、文档、下载、OneDrive 等常见目录。
- 只认 `manifest.json` 中 `format` 为 `dsh-portable-backup` 的备份。
- 同级必须存在 `data/` 文件夹；两者绑定才算有效备份，避免把普通 ZIP 或空文件夹误判。
- 同时支持文件夹备份和 `DSH备份_*.zip` / `dsh-backup_*.zip` 文件备份。
- 结果按备份时间从新到旧排列，并显示完整绝对路径；选择后直接恢复。

### 3. 只导入官方 `/export` 的会话

在 DSH 会话头部“更多操作”里选“下载 Session 日志”，或输入 `/export`，得到 `dsh-session-<id>.zip`。然后：

```bat
dsh-portable.cmd import "C:\Users\你\Downloads\dsh-session-xxxx.zip" ^
  --workspace "C:\Users\你\Documents\deepseek-harness\default-workspace"
```

导入后重启 DSH。子会话、图片、通用文件会一起恢复。

## 三种保存方式怎么选

> 最省事：插好 U 盘，菜单选 `7`，工具会自动创建 `E:\DSH备份` 并把 ZIP 放进去。

| 方式 | 适合 | 优点 | 注意 |
|---|---|---|---|
| **U 盘便携模式**（`DSH_HOME`） | 长期在 U 盘上使用 DSH | 数据直接写 U 盘，换机改环境变量即可 | 盘符变化、拔盘、云同步冲突 |
| **官方 `/export` + 本工具 import** | 只带走几条会话 | 官方格式，单会话可控 | 一次一条，子会话/附件会一起导出 |
| **整库 backup + restore** | 重装系统、换电脑 | 最完整，含工作区归属 | 恢复前必须退出 DSH |

### U 盘便携模式

```bat
:: 1. 退出 DSH
:: 2. 把当前数据恢复到 U 盘目录（也可以直接让 DSH 新建）
dsh-portable.cmd restore E:\DSH备份\dsh-2026-10-18.zip --home E:\DSH-Portable --settings
:: 3. 设置用户环境变量（设置后对新启动的进程生效）
setx DSH_HOME "E:\DSH-Portable"
:: 4. 重新启动 DSH
```

换电脑时：安装 DSH → 插 U 盘 → `setx DSH_HOME "E:\DSH-Portable"` → 启动。

注意：

- 盘符从 `E:` 变成 `F:` 时，要同步改 `DSH_HOME`。
- 不要在使用中直接拔 U 盘；先退出 DSH。
- U 盘如果是 exFAT / FAT32，可能不支持 DSH 附件库的硬链接；建议用 NTFS 移动硬盘/SSD，或先用一个小会话测试。
- **不要**把 `DSH_HOME` 指向 OneDrive/坚果云等实时同步目录：JSONL 追加和 `workspace.json` 写入可能冲突。要上云请用“备份 ZIP”，不要用“实时同步”。

## 命令

```text
dsh-portable.cmd                         打开中文菜单
dsh-portable.cmd list                    查看本机已存会话
dsh-portable.cmd backup [选项]           备份
dsh-portable.cmd backup --usb            自动找 U 盘并建 DSH备份 文件夹
dsh-portable.cmd scan                    自动搜索所有盘上的备份
dsh-portable.cmd inspect <备份>          查看备份内容
dsh-portable.cmd restore <备份> [选项]   恢复整库
dsh-portable.cmd restore --auto [选项]   搜索并恢复最新备份
dsh-portable.cmd import <ZIP...> [选项]  导入官方 /export 会话包
dsh-portable.cmd portable                查看便携模式说明
```

### backup

| 选项 | 说明 |
|---|---|
| `--out <路径>` | 输出文件夹或 `.zip` |
| `--zip` | 输出 ZIP |
| `--usb` | 自动检测可移动磁盘，创建 `<U盘>:\DSH备份` 并输出 ZIP |
| `--drive E:` | 指定磁盘盘符；可与 `--usb` 一起用，也可单独用 |
| `--settings` | 同时备份 `profiles/` |
| `--credentials` | 同时备份 `.credentials.yaml`（敏感，默认不备份） |
| `--force` | 覆盖已存在的输出 |
| `--home <路径>` | 指定 DSH 数据目录（默认 `$DSH_HOME` 或 `%USERPROFILE%\.dsh`） |

备份可以在 DSH 运行时做“热备份”，但当前会话最后几条消息可能还没落盘；最稳妥是退出 DSH 再备份。

### restore

| 选项 | 说明 |
|---|---|
| `--auto` | 自动搜索所有盘，选择时间最新的备份 |
| `--mode merge` | 默认，保留现有会话，只补缺失的 |
| `--mode replace` | 先把现有 `sessions/` 改名为 `sessions.bak-<时间>`，再恢复 |
| `--workspace <路径>` | 找不到原工作区时，统一迁到这个目录 |
| `--force-workspace` | 强制所有会话都使用 `--workspace` |
| `--map 旧=新` | 路径映射，可重复；例如 `--map "C:\Users\Old=C:\Users\New"` |
| `--settings` | 恢复 `profiles/` |
| `--credentials` | 恢复 `.credentials.yaml` |
| `--overwrite` | 覆盖同 ID 会话（危险） |
| `--dry-run` | 只演练，不写文件 |
| `--create-anywhere` | 允许在当前用户目录之外创建工作区 |
| `--force` | DSH 运行中仍然写入（不推荐） |

默认行为：

- 新电脑用户名不同：自动把 `C:\Users\旧名` 映射到 `C:\Users\新名`。
- 会话已存在：默认跳过，不覆盖。
- 工作区不存在：只在当前用户目录下创建；其他路径需要 `--workspace` 或 `--create-anywhere`。
- 默认不恢复凭据；新电脑重新登录即可。

### import

| 选项 | 说明 |
|---|---|
| `--workspace <路径>` | 导入到指定工作区（默认沿用原 `cwd`） |
| `--map 旧=新` | 路径映射，可重复 |
| `--overwrite` | 覆盖同 ID 会话 |
| `--dry-run` | 只演练 |
| `--force` | DSH 运行中仍然写入（重启后生效） |
| `--home <路径>` | 指定 DSH 数据目录 |

## 备份里有什么

```text
dsh-backup-YYYYMMDD-HHMMSS/
  manifest.json                 # 来源机器、会话列表、标题、路径
  data/
    sessions/                   # 会话 JSONL.zstd
    attachments/v1/             # objects / files / file-objects
    storages/workspace.json     # 工作区归属
    profiles/                   # 可选：插件与设置
    .credentials.yaml           # 可选：敏感
```

不备份：`cache/`、`dsh-runtimes/`、`speech-to-text/`、`storages/session_projcache/`（缓存可重建）。

## 它怎么工作（简版）

- DSH 的会话文件是“拼接的 Zstandard 帧”：第一帧只有一行 header，后面是事件帧。
- 本工具只改写 header 里的 `cwd`，**其余事件帧按原字节保留**；导入官方 ZIP 时重新编码为 header 帧 + 事件帧，并带 checksum。
- 恢复/导入后把 `storages/workspace.json` 的 `initialized` 置为 `false`，让 DSH 自己在下次启动时按 header 的 `cwd` 重新分组，不需要手写 `workspace.json` 的会话归属。
- 附件按 SHA-256 内容寻址，导入时校验摘要后写入 `attachments/v1/objects`（图片）或 `file-objects + files`（通用文件）。

## 安全与隐私

- 备份 ZIP 包含完整对话、工具输出、附件和本机路径；上传公共云前请先加密（7-Zip / VeraCrypt / age）。
- `.credentials.yaml` 默认不备份；加 `--credentials` 会把它放进备份，泄露风险自负。
- 恢复/导入默认要求 DSH 完全退出；`--force` 只建议在明确知道后果时使用。
- 第一次使用请先 `--dry-run`，确认“恢复几条、跳过几条、工作区映射到哪里”。
- 本工具不会联网，不会上传任何数据。

## 兼容性

- 开发/验证环境：DeepSeek Harness `0.2.0-rc.2`（Desktop runtime `0.2.1-rc.2`），Windows 11，会话格式 v4。
- 读取 v0–v4 的 `session[.vN].jsonl[.zstd]`；更高版本如果格式变化，可能需要更新工具。
- 恢复目标建议使用**相同或更新**的 DSH 版本；旧版 DSH 可能拒绝新版会话。
- 目前只提供 Windows `.cmd` 启动器；Node 核心本身跨平台，macOS/Linux 可手动 `node dsh-portable.mjs`。

## 和现有插件的对比

社区已经有不少成熟项目，例如：

- [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup)：整库备份/恢复/迁移、定时、GitHub 同步、救援控制台。
- [`@he0119/dsh-session-manager`](https://github.com/he0119/dsh-session-manager)：`.dshsess` 导入导出 + WebDAV 多机同步。
- [`dsh-session-sync`](https://github.com/PerryLink/dsh-session-sync)：私有 git 仓库同步、三向合并、可选 age 加密。
- [`dsh-session-mgr`](https://github.com/mienfong/dsh-session-mgr)：Web UI 内移动/归档/便携备份/导入。
- [`@feiyang666/dsh-vault`](https://github.com/feiyang-dev/dsh-vault)：自动快照 + 清空检测 + 一键恢复。
- [`dsh-session-share`](https://github.com/quicksandznzn/dsh-session-share)：把会话树分享给别人。

完整对比、安装命令和选择建议见 [docs/COMPARISON.md](docs/COMPARISON.md)。

**本项目不替代它们**：如果你要“日常自动备份 + 云同步”，优先用上面成熟插件；如果你要“DSH 起不来也能救、不装插件、只拿到官方导出 ZIP、换用户名后还能恢复”，用 `dsh-portable`。

## 常见问题

**恢复后侧边栏没有会话？**

先确认恢复了会话文件，再重启 DSH。工具会把 `workspace.json` 的 `initialized` 设为 `false`，DSH 启动时会重新扫描并分组。仍然没有的话，看 `list` 是否有记录，以及 DSH 启动日志是否报 workspace 错误。

**新电脑用户名不一样怎么办？**

默认会自动把旧用户目录映射到新用户目录。如果工作区在 `D:` 等其他盘，用：

```bat
dsh-portable.cmd restore backup.zip --workspace "C:\Users\新用户名\Documents\deepseek-harness\default-workspace"
```

或逐条映射：

```bat
dsh-portable.cmd restore backup.zip --map "D:\Projects=C:\Users\新用户名\Projects"
```

**提示“目标 DSH 已有同一 ID 的会话”**

默认保留现有会话，不覆盖。确认要覆盖时加 `--overwrite`；覆盖前建议先单独备份现有数据。

**没有装 Node.js 能用吗？**

可以。启动器会依次查找 DSH 自带的 `node.exe`、安装目录里的运行时、系统 `node`。只要安装过 DSH，一般不需要另装 Node。

**能直接同步到云端吗？**

本工具不联网，不做实时同步。要云同步请用 `dsh-backup` 的 GitHub 同步、`dsh-session-manager` 的 WebDAV，或 `dsh-session-sync` 的 git 同步；也可以把备份 ZIP 手动放云盘。

**会不会覆盖我现在的会话？**

默认 `merge`，只补缺失的；同 ID 默认跳过。只有显式 `--overwrite` 或 `--mode replace` 才会覆盖。

**支持 macOS/Linux 吗？**

核心是 Node 脚本，理论上可运行：

```bash
node dsh-portable.mjs list --home ~/.dsh
```

但当前只提供 Windows 启动器和 Windows 场景测试，其他平台未验证。

## 开发

无第三方依赖，要求 Node.js `>=22.15`（需要 `zlib` 的 Zstandard API）。

```bash
node dsh-portable.mjs help
node dsh-portable.mjs list
```

目录：

```text
dsh-portable.mjs        # CLI / 中文菜单
dsh-portable.cmd        # Windows 启动器（自动找 DSH 自带 node）
lib/zip.mjs             # 无依赖 ZIP 读写
lib/zstd.mjs            # Zstandard 帧读写、header 改写
lib/session.mjs         # 会话发现、路径编码、workspace 读取
lib/workspace.mjs       # workspace.json 合并/去重
lib/backup.mjs          # 备份/恢复/官方 ZIP 导入
lib/usb.mjs             # 检测 U 盘、创建 DSH备份 文件夹
lib/scan.mjs            # 搜索所有盘、manifest + data 识别备份
docs/COMPARISON.md      # 与现有插件的对比
docs/GITEE.md           # 发布到 Gitee 的步骤
```

验证记录：

- **2026-10-19，v1.2.0**：`scan` 扫描 C:/D:/E:，找到 `E:\DSH备份\DSH备份_20261019-210150.zip` 和桌面工具目录里的文件夹备份；`restore --auto --dry-run` 正确选择最新 ZIP，预览恢复 12 个会话、211 个附件，未写盘。
- **2026-10-19，v1.1.0**：`backup --usb` 检测到可移动磁盘 `E: ESD-USB`，自动创建 `E:\DSH备份` 并写入 ZIP；测试后已清理。
- **2026-10-18，v1.0.0**：11 个真实会话、137 个附件，备份/恢复到临时 `DSH_HOME`，逐会话校验 5106 条事件、`seq` 连续、`cwd` 重映射正确。
- 用临时 `DSH_HOME` 启动 `dsh web`，确认恢复后的 workspace 能自动注册 11 个会话、无重复归属错误。
- 导入官方格式 ZIP（含 39 张图片、子会话、中文文件名通用文件）验证通过。

## License

[MIT](LICENSE)

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话格式与 workspace bootstrap 设计。
- 上面列出的社区项目，为本项目提供了很多边界场景的参考。
