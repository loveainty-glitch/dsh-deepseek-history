# dsh-deepseek-history

把 DeepSeek 网页版（chat.deepseek.com）的对话历史整理进 DeepSeek Harness。

## 功能

- 连接网页账号：面板里粘贴 `userToken`，校验后存入 DSH 凭据库（`DEEPSEEK_WEB_TOKEN`）。
- 同步历史：拉取全部会话及消息，导出成按日期分文件夹的 Markdown，并导入为原生 DSH Session。
- 增量去重：已导入且未变更的会话不会重复创建。
- Agent 工具：`deepseek_history_status`、`deepseek_history_list`、`deepseek_history_sync`、`deepseek_history_open_panel`。

## 使用

1. 安装并启用本插件后刷新页面，点右下角「🕘」按钮打开面板。
2. 点「打开登录页」在浏览器登录 chat.deepseek.com，F12 → Console 执行 `JSON.parse(localStorage.userToken).value`，复制结果粘到面板点「连接」。
3. 点「开始同步」。

Markdown 归档目录：`<DSH_HOME>/deepseek-history/export/`。

## 说明与限制

- DeepSeek 官方 API 不存对话历史，网页历史只能通过浏览器会话令牌读取；令牌仅存于 DSH 凭据库，不写入插件目录明文。
- 令牌会过期，过期后需重新从浏览器获取并连接。
- 同步的是当前登录账号下的会话；图片/文件附件不导入（仅文本与思考过程）。
- 将网页登录态用于第三方工具有账号风险，请自行评估并遵守 DeepSeek 服务条款。
