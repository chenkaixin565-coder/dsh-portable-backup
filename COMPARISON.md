# DSH 会话备份/迁移方案对比

> 调研时间：2026-10-18。版本号来自 npm registry；功能描述来自各项目 README/包元数据。
> 社区插件更新很快，安装前请以项目最新 README、issue 和兼容性说明为准。
> 本文不是安全审计，也不是“推荐安装”背书；涉及写入 `~/.dsh` 的操作，请先备份。

## 先看结论

- **只想“把会话导出成一个包带走”**：官方 `/export` 已经够用，但官方没有导入。
- **想“整库备份 + 换机 + 云同步 + 自救”**：优先看 [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup)。
- **想“多台机器通过 WebDAV 自动同步”**：看 [`@he0119/dsh-session-manager`](https://github.com/he0119/dsh-session-manager)。
- **想“用私有 git 仓库同步、可加密”**：看 [`dsh-session-sync`](https://github.com/PerryLink/dsh-session-sync) 或 [`@linbin-mk/dsh-session-sync`](https://github.com/linbin-mk/dsh-session-sync)。
- **想在 Web UI 里管理会话、顺手导出/导入**：看 [`dsh-session-mgr`](https://github.com/mienfong/dsh-session-mgr)。
- **怕桌面端异常清空数据、要自动快照**：看 [`@feiyang666/dsh-vault`](https://github.com/feiyang-dev/dsh-vault)。
- **想把自己的会话分享给别人**：看 [`dsh-session-share`](https://github.com/quicksandznzn/dsh-session-share)。
- **不想装插件、只想双击一个程序做 U 盘救援/换机**：用本项目 `dsh-portable`。

## 总表

| 项目 | 形态/安装 | 备份范围 | 导入/恢复 | 多机同步 | 中文 | 适合场景 |
|---|---|---|---|---|---|---|
| 官方 `@deepseek-ai/dsh-session-log-export` | DSH 内置，`/export` 或会话头部菜单 | 单会话 + 子会话 + 附件 ZIP | ❌ 官方无导入 | ❌ | ✅ | 临时导出、给官方提 issue |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) | 插件 + CLI + Web 面板；`dsh plugin … add` | 全量/分类型；定时、升级快照、sha256 校验 | ✅ `/backup restore` | GitHub 同步 | ✅ | 功能最全的整库备份/迁移 |
| [`@he0119/dsh-session-manager`](https://github.com/he0119/dsh-session-manager) | 插件，设置页 | `.dshsess` 会话包 | ✅ 导入并改写 `cwd` | **WebDAV** | ✅ | 多机同步、迁移工作区 |
| [`dsh-session-sync`](https://github.com/PerryLink/dsh-session-sync) | 插件，`/sync` + 工具 | git 镜像 | ✅ pull/push，三向合并 | **git 私有仓库**，可 age 加密 | ✅ | 极客、自建同步 |
| [`@linbin-mk/dsh-session-sync`](https://github.com/linbin-mk/dsh-session-sync) | 插件，设置页/行菜单 | git 镜像 | ✅ | git | ✅ | 同上，UI 更完整 |
| [`dsh-session-mgr`](https://github.com/mienfong/dsh-session-mgr) | Web 插件 | 便携归档（portable archive） | ✅ 跨工作区导入 | ❌ | ✅ 三语 | Web UI 内管理 + 便携包 |
| [`@feiyang666/dsh-vault`](https://github.com/feiyang-dev/dsh-vault) | 插件，设置页 | 自动备份到 `~/.dsh-backups`，含凭据 | ✅ 一键恢复 | ❌ | ✅ | 防桌面端清空、自动快照 |
| [`dsh-session-share`](https://github.com/quicksandznzn/dsh-session-share) | 插件，`/share-session` | 单会话树 ZIP | ✅ 新 ID 导入 | ❌ | ✅ | 分享会话给他人 |
| [`dsh-session-manager`](https://github.com/hkkz9522/dsh-session-manager) | 插件 | ❌ 偏管理 | ❌ | ❌ | ✅ | 移动/归档/标签/批量管理 |
| **本项目 `dsh-portable`** | **双击 `.cmd`，零第三方依赖** | **整库文件夹/ZIP** | **✅ 整库 + 官方 `/export` ZIP** | ❌（手动 U 盘/云盘） | ✅ | **不装插件、U 盘救援、换机、路径重映射** |

## 逐项说明

### 1. 官方导出：`@deepseek-ai/dsh-session-log-export`

- 当前 DSH Web bundle 默认挂载；会话头部“更多操作 → 下载 Session 日志”或 `/export`。
- 导出内容：根会话、子会话树、图片、通用文件。
- 限制：**只有导出，没有导入**；目标位置由浏览器下载管理器决定，不写 Host 路径。
- 适合：临时备份一条会话、给官方提 issue、把会话发给别人（对方需自行处理导入）。

### 2. `@xiaoyuyu6420/dsh-backup`

- 当前 npm 版本：`0.13.4`，MIT。
- 一条命令/一个 `/backup` 覆盖：全量或分类型备份、定时自动备份、升级前快照、恢复、校验、日志体检修复、迁移预检、进程外救援控制台、凭据脱敏、GitHub 同步。
- 备份目录默认在桌面 `dsh-backups/`，带 sha256 校验。
- 优点：功能最完整，考虑了“DSH 起不来”的救援场景；对 Windows 路径（含 `DSH_HOME` 在盘符根）有专门修复。
- 代价：插件形态，需要 DSH 能启动；功能多，配置项也多。
- 安装示例（以项目 README 为准）：
  ```bat
  dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
  ```
  桌面版请优先用内置插件管理器；profile 名可能是 `desktop` 而不是 `web`。

### 3. `@he0119/dsh-session-manager`

- 当前 npm 版本：`0.6.0`，MIT。
- 设置页里的“会话管理”：导出/导入 `.dshsess` 会话包；把工作区与会话迁移到新目录，改写日志 `cwd`、迁移目录、重挂工作区归属，可选搬迁会话产物。
- **WebDAV 多机同步**：远端只放 `.dshsess` 包，拉取时按映射把 `cwd` 改写成本机路径；一台机器一个目录，避免互相覆盖。
- 优点：最接近“云端/登录加载”的体验；有只读计划、确认弹窗、字节级备份。
- 代价：需要自备 WebDAV（坚果云、Nextcloud、群晖等）；同步不是实时，需手动或定时触发。
- 适合：有两台以上电脑、希望会话自动出现在另一台机器的用户。

### 4. `dsh-session-sync` / `@linbin-mk/dsh-session-sync`

- `dsh-session-sync` 当前 `0.2.26`，Apache-2.0；`@linbin-mk/dsh-session-sync` 当前 `0.9.0`，MIT。
- 把会话库镜像到独立的 git worktree，再推送到**你自己的**私有 git 仓库；`/sync status|diff|log|pull|push`，支持自动 push/pull。
- 冲突策略：append-only 三向合并、keep-both、冲突生成 fork 文件，不 force push、不 reset。
- 可选 `age` 加密；默认是明文 git（务必用私有仓库）。
- 优点：不依赖第三方云；版本历史清晰；可审计。
- 代价：需要 git；对非技术用户门槛较高；加密不是默认。
- 适合：有私有 Git 仓库、愿意折腾的极客。

### 5. `dsh-session-mgr`

- 当前 npm 版本：`0.6.8`，MIT。
- Web UI 会话管理：移动、归档、恢复、便携归档备份、跨工作区导入、删除；三语（英/简/繁）。
- 优点：在 DSH 界面里直接操作，学习成本低；适合日常整理。
- 代价：不是整库自动备份/云同步；仍依赖 DSH 运行。
- 适合：会话很多、需要批量移动/归档/导入导出的用户。

### 6. `@feiyang666/dsh-vault`

- 当前 npm 版本：`1.5.0`，MIT（旧名 `@feiyang666/deepseekharnessdesktop-vault`，新包名是 `@feiyang666/dsh-vault`）。
- 自动备份 `sessions/`、`storages/`、`settings.yaml`、`.credentials.yaml`、`profiles/` 到 `~/.dsh-backups/`；启动备份、异常关闭备份、手动备份；最多保留 10 份；清空检测；设置页一键恢复；生成离线 `restore-latest.ps1`。
- 优点：专门防“桌面端异常清空 `~/.dsh`”；备份在 DSH 目录之外。
- 代价：默认包含凭据，备份目录要妥善保管；不提供多机同步。
- 适合：把 DSH 当主力工具、最怕数据被清空的用户。

### 7. `dsh-session-share`

- 当前 npm 版本：`0.1.1`，MIT。
- `/share-session` 导出当前会话树为 `.dsh-session-share.zip`；`/import-session` 导入。
- 导入会创建**全新本地 Session 树和新 ID**，不是恢复原会话；适合分享，不适合“继续我自己的原会话”。
- 不加密、不脱敏；分享前自行检查敏感内容。

### 8. `dsh-session-manager`（hkkz9522）

- 当前 npm 版本：`0.7.2`，MIT。
- 偏“会话与工作区管理”：跨工作区移动、归档、收藏、待回看、优先级、标签、备注、批量操作、预设迁移。
- 不是备份/同步工具；适合整理，不适合灾备。

## 怎么选：一张决策图

```text
你主要想解决什么？
├─ 只是把某条会话带走/发给别人
│  ├─ 只导出 → 官方 /export
│  └─ 对方也要能继续 → dsh-session-share 或 本项目 import
├─ 换电脑/重装系统，整库搬过去
│  ├─ 想全自动、功能全 → dsh-backup
│  └─ 不想装插件、想双击就用 → 本项目 dsh-portable
├─ 两台电脑经常切换，想自动同步
│  ├─ 有 WebDAV → @he0119/dsh-session-manager
│  └─ 有私有 git → dsh-session-sync
├─ 怕 DSH 崩溃/清空数据
│  └─ @feiyang666/dsh-vault + 本项目定期 ZIP
└─ 只是整理会话
   └─ dsh-session-mgr / hkkz9522 的 dsh-session-manager
```

## 本项目的定位（不重复造轮子）

`dsh-portable` 不试图替代 `dsh-backup`。它解决的是另一类场景：

1. **DSH 已经起不来，或你不想先装插件**：双击 `.cmd` 就能在进程外备份/恢复。
2. **只拿到官方 `/export` 的 ZIP**：官方没有导入，本项目可以把它导回 DSH。
3. **换了 Windows 用户名/盘符**：自动把旧 `cwd` 映射到新用户目录，避免会话全部变成“未分组”。
4. **想把数据直接放 U 盘**：提供 `DSH_HOME` 便携模式说明，不依赖任何插件。
5. **中文、零第三方依赖**：复用 DSH 自带的 Node 运行时，不需要 `npm install`。

如果你已经装了 `dsh-backup`，仍然可以把它当作“日常自动备份”，把 `dsh-portable` 当作“换机/救援时的离线工具”。两者备份格式不同，互不冲突。

## 发布到 Gitee 时的注意事项

- 不要在 README 里写“唯一/最强”；上面这些项目很多比本项目成熟，如实写差异反而更容易获得信任。
- 明确“非官方项目”，不暗示 DeepSeek 背书。
- 明确“恢复前必须退出 DSH”；不要承诺热恢复。
- 默认不备份 `.credentials.yaml`；文档里写清风险。
- 给出可复现的测试环境（DSH 版本、Windows 版本），不要只写“可用”。
- 如果以后做成 DSH 插件，遵守 Cordis bundle 规范，并在 README 里写清兼容的 DSH 版本范围。
