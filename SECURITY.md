# Security

## 这个工具会接触哪些数据

`dsh-portable` 读取和写入 DeepSeek Harness 的数据目录（默认 `%USERPROFILE%\.dsh`）：

- `sessions/`：完整对话、工具调用与输出、工作区路径。
- `attachments/`：图片和上传的文件。
- `storages/workspace.json`：工作区与会话归属。
- `profiles/`：插件与设置（可选备份）。
- `.credentials.yaml`：登录/API 凭据（**默认不备份**，只有显式 `--credentials` 才处理）。

## 备份文件的安全等级

备份 ZIP / 文件夹等同于“未加密的聊天记录 + 附件 + 路径信息”。请：

- 不要上传到公开网盘或公开 Git 仓库。
- 上传云盘前用 7-Zip（AES-256）、VeraCrypt、age 等加密。
- 不要提交到 Gitee/GitHub；本仓库 `.gitignore` 已忽略常见备份产物，但不能替代你自己检查。

## 凭据

- 默认不备份 `.credentials.yaml`。
- `--credentials` 会把凭据放进备份；不同 Windows 机器/用户可能因 DPAPI 无法直接复用，通常重新登录更安全。
- 不要把含凭据的备份发给任何人。

## 写入安全

- 恢复/导入默认要求 DSH 完全退出；工具会检测 `DeepSeek Harness.exe` 进程。
- `--force` 会绕过该检查，只建议在你明确知道 DSH 不会同时写 `workspace.json` 时使用。
- 默认 `merge` 模式不会删除现有会话；`--mode replace` 会先把 `sessions/` 改名为 `sessions.bak-<时间>`。
- 覆盖同 ID 会话需要显式 `--overwrite`。

## 报告问题

如果你发现路径穿越、ZIP 解析、覆盖逻辑或凭据处理方面的安全问题，请先不要在公开 issue 里贴敏感数据；用仓库的私密渠道联系维护者，或只提供脱敏后的复现步骤。
