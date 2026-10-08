# 配置说明

普通安装只需要 SPT。以下选项用于自动化安装、调整部署位置或配置摘要。

## 非交互安装

将凭据放入本地配置文件，例如仓库根目录的 `wxpusher.json`：

```json
{
  "spt": "SPT_your_token"
}
```

把占位值换成自己的 SPT，然后运行：

```sh
node install.mjs --agent both --config wxpusher.json --non-interactive --dry-run
node install.mjs --agent both --config wxpusher.json --non-interactive
```

第一条只预览，第二条执行安装。非交互模式下不询问测试推送；需要测试时另加 `--test`。

也可以由运行环境提供 `WXPUSHER_SPT`，无需创建凭据文件或把 SPT 写进命令行参数：

```sh
node install.mjs --agent pi --non-interactive
```

这条命令要求环境中已有 `WXPUSHER_SPT`，或者已有可用的本地配置。

SPT 的取值顺序是：本次交互输入 → `WXPUSHER_SPT` → `--config` 指定的文件（未指定时读取仓库的 `wxpusher.json`）→ 已安装的配置。

`host`、`proxy` 和 `node` 则优先采用命令行参数，其次是已安装的值，最后才是配置文件中的值。更新时不会用仓库里的机器设置覆盖另一台机器的设置。`summary` 等其他字段会合并，输入配置中的同名字段覆盖已有值。

## 安装参数

| 参数 | 作用 |
| --- | --- |
| `--agent codex\|pi\|both` | 选择目标；未指定时按现有目录检测，交互模式可重新选择 |
| `--host <名称>` | 通知中显示的机器名，默认使用已有值或系统主机名 |
| `--config <文件>` | 读取本地 JSON 配置文件 |
| `--proxy <URL>` | 摘要请求使用的代理，不为 WxPusher 推送请求设置代理 |
| `--node <路径>` | Node 可执行文件的绝对路径，默认沿用已有值或当前解释器 |
| `--non-interactive` | 不询问输入，缺少 SPT 时退出 |
| `--dry-run` | 只显示将修改的文件，不写文件、不发消息 |
| `--test` | 安装后为每个选定 agent 发送一条真实测试通知 |
| `--help` | 显示用法 |

`--dry-run` 和 `--test` 不能同时使用。

## 部署位置

| 文件 | Codex | Pi |
| --- | --- | --- |
| 运行时配置 | `~/.codex/wxpusher.json` | `~/.pi/agent/wxpusher.json` |
| 发送脚本 | `~/.codex/send-wxpusher-stop.mjs` | `~/.pi/agent/send-wxpusher-stop.mjs` |
| 接入入口 | `~/.codex/hooks.json` 中的 `Stop` | `~/.pi/agent/extensions/codex-stop-wxpusher.ts` |

自定义目录使用 agent 的原生环境变量：Codex 的 `CODEX_HOME`、Pi 的 `PI_CODING_AGENT_DIR`。建议使用绝对路径，并在安装和运行 agent 时使用相同的设置。

两边的发送脚本内容相同，但各自读取旁边的配置。配置会记录 Node 路径，Pi 扩展和新建的 Codex hook 使用这份解释器。旧 Codex hook 保留原命令；显式传入 `--node` 才会更新它，之后可能需要重新审阅 hook。

旧版 Pi 与 Codex 共用配置。首次安装独立 Pi 配置时，`--agent both` 会以已有 Codex 配置作为底稿；只安装 Pi 且没有提供新的凭据来源时，也会尝试沿用旧 Codex 配置。原文件不删除。

## 摘要

没有可用的模型端点时，通知使用最后回复的首行。生成模型摘要不是发送通知的前提。

脚本按以下顺序尝试 OpenAI 兼容的 `/chat/completions` 端点：

1. Pi 扩展提供的当前模型、端点和可用凭据。
2. 能从 Codex `config.toml` 解析到的 provider 配置，包括 `env_key` 指定的环境变量。
3. 运行时配置中的 `summary`。

自动读取不是通用的认证适配器。ChatGPT 登录、其他 API 协议或无法解析的 provider 配置，可能无法用来生成摘要。

如需指定备用端点，在对应 agent 的运行时 `wxpusher.json` 中添加：

```json
{
  "spt": "SPT_your_token",
  "host": "desktop",
  "summary": {
    "base_url": "https://your-api.example/v1",
    "api_key": "your-api-key",
    "model": "your-model"
  }
}
```

这是备用端点，优先级低于自动取得的端点；不修改 agent 本身使用的模型。不要把含真实 key 的配置提交到仓库。

配置 `proxy` 后，每个摘要端点同时尝试直连和代理，采用先返回的有效摘要。代理请求需要支持 `NODE_USE_ENV_PROXY` 的 Node。通知在后台处理，摘要请求超时可能使消息晚一些到达。

## 调试

`WXPUSHER_SYNC=1` 让发送脚本在前台完成摘要和推送，失败时返回非零退出码。`CODEX_STOP_WXPUSHER_DRY_RUN=1` 跳过摘要与推送；它不会撤销安装操作。

例如，在 Linux / macOS 上直接检查已部署的 Codex 发送脚本：

```sh
printf '%s' '{"last_assistant_message":"通知链路测试"}' \
  | WXPUSHER_SYNC=1 node ~/.codex/send-wxpusher-stop.mjs
```

这会发送真实消息，不是离线测试。Windows PowerShell 可设置 `$env:WXPUSHER_SYNC = '1'`，将同样的 JSON 字符串通过管道传给发送脚本。优先用 README 中的 `--test` 命令检查，不需要手动拼接 hook 输入。

发送脚本的 `--summarize-only <文件>` 只请求摘要模型，不向 WxPusher 发消息。文件格式为 `{ "target": { "base_url": "...", "api_key": "...", "model": "..." }, "context": "..." }`；结果以 `WXPUSHER_RECAP:` 开头。此文件同样包含凭据，应妥善保管。
