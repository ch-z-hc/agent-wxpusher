# agent-wxpusher

在 Codex / Pi 回合结束时，通过 [WxPusher](https://wxpusher.zjiecode.com/) 发送通知。

Codex 使用 `Stop` hook，Pi 使用 `agent_settled` 扩展。通知在后台发送，内容包括机器名、agent 和本轮回复的摘要。无需安装 npm 依赖或构建。

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

```text
[laptop · Codex]
修复登录页的表单验证
任务已完成
时间：2026-10-08 15:30:00
```

通知表示回合已经结束，不判断任务是否成功。

## 安装

需要 Node.js 18+，以及支持 `Stop` hook 的 Codex 或支持 `agent_settled` 的 Pi。只用其中一个即可。

先按 [WxPusher 的 SPT 指南](https://wxpusher.zjiecode.com/docs/spt.html) 扫码获取自己的推送令牌。本项目使用极简推送，不需要 appToken 或 UID。

```sh
git clone https://github.com/ch-z-hc/agent-wxpusher.git
cd agent-wxpusher
node install.mjs
```

按提示选择 `codex`、`pi` 或 `both`，输入 SPT 和机器名。SPT 不会回显；已有值可以按回车保留。安装结束时可以选择发送测试通知，默认不发送。

安装后还有一步：

- **Codex**：打开 `/hooks`，审阅、信任并启用通知 hook。安装器不会绕过 [Codex 的 hook 信任检查](https://learn.chatgpt.com/docs/hooks)。
- **Pi**：运行 `/reload` 或重开会话，加载新扩展。

也可以指定安装目标：

```sh
node install.mjs --agent pi
```

## 验证通知

跳过交互，重新部署并发送一条 Codex 测试通知：

```sh
node install.mjs --agent codex --non-interactive --test
```

Pi 将 `codex` 换成 `pi`。选 `both` 会分别发送两条。

测试不调用摘要模型。命令成功后，检查接收端是否收到消息，再让对应 agent 跑完一轮，确认结束通知能自动触发。

## 配置

配置保存在 `~/.codex/wxpusher.json` 或 `~/.pi/agent/wxpusher.json`。每个 agent 使用自己目录下的发送脚本，安装器不修改模型或 API 配置。

机器名和摘要代理可以通过参数设置：

```sh
node install.mjs --agent both --host desktop --proxy http://127.0.0.1:7897
```

`proxy` 只用于摘要请求。使用代理时，Node 需要支持 `NODE_USE_ENV_PROXY`；建议使用较新的 Node 24 版本。

配置文件、非交互安装、自定义目录和摘要端点，见 [配置说明](docs/configuration.md)。完整参数可通过 `node install.mjs --help` 查看。

## 更新

在原仓库目录中运行：

```sh
git pull --ff-only
node install.mjs
```

安装器会更新部署副本，保留机器名等已有设置。通知命令没变时，不重写 `hooks.json`；已有 JSON 损坏时会报错，而不是覆盖它。Pi 更新后需要再次 `/reload`。

## 常见问题

### 测试通知也收不到

检查 SPT 和到 `wxpusher.zjiecode.com` 的网络连接。测试命令失败会返回非零退出码；如果接口请求成功但接收端没有提醒，检查 WxPusher 的消息列表和 [接收端通知设置](https://wxpusher.zjiecode.com/docs/open-app-note/)。

### 测试正常，回合结束却没有通知

Codex 在 `/hooks` 中检查 hook 是否已信任、是否启用；Pi 确认扩展已经重载，且当前版本支持 `agent_settled`。测试发送成功不代表 hook 或扩展已加载。

### 摘要只是最后回复的第一行

没有取得可用的摘要模型时会这样。摘要只支持 OpenAI 兼容的 `/chat/completions` 接口，不能保证复用 ChatGPT 登录或其他 API 协议；不影响通知发送。配置方式见 [摘要说明](docs/configuration.md#摘要)。

## 数据与凭据

消息正文会发送给 WxPusher。生成摘要时，本轮用户请求和最后一条回复还会发送给所选模型端点；涉及敏感内容的会话，安装前应考虑这两处数据传输。

SPT 是推送凭据，不要提交到仓库、贴进日志或截图。仓库根目录的 `wxpusher.json` 已被 Git 忽略；使用自定义配置文件时，需自行避免将它提交。

## 开发

修改仓库中的源文件，再运行安装器部署；不要直接修改 agent 目录中的副本。

```sh
node --check install.mjs
node --check send-wxpusher-stop.mjs
node --test test.mjs
```

完整测试使用 Node 24+。测试在临时目录中安装，用模拟 HTTP 请求验证通知，不发送真实消息，也不改现有部署。

提交问题或改动时，请附上 agent 与 Node 版本、复现命令和测试结果，不要附真实 SPT 或 API key。

## 许可证

[MIT](LICENSE)
