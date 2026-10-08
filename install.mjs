// Configure and install the shared notifier. No agent model settings are changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_DIR = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const PI_DIR = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const SCRIPT_NAME = "send-wxpusher-stop.mjs";
const EXT_NAME = "codex-stop-wxpusher.ts";
const argv = process.argv.slice(2);
const flags = new Set(["--dry-run", "--test", "--non-interactive", "--help"]);
const values = new Set(["--agent", "--host", "--proxy", "--node", "--config"]);
const options = {};

function readJson(file, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    // Do not echo parser errors: they can contain credentials from the file.
    throw new Error(`${file} 无法读取或不是有效的 JSON 对象；未覆盖该文件`);
  }
}

function quote(value) {
  return process.platform === "win32" ? `"${value}"` : `'${value.replace(/'/g, "'\\''")}'`;
}

async function main() {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.has(arg)) options[arg] = true;
    else if (values.has(arg) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) options[arg] = argv[++i];
    else throw new Error(`未知参数或缺少参数值：${arg}；用 --help 查看用法`);
  }
  if (options["--help"]) {
    console.log("node install.mjs [--agent codex|pi|both] [--config file] [--host label] [--proxy url] [--node path] [--dry-run] [--test] [--non-interactive]");
    console.log("无参数时交互配置；非交互的 SPT 可从 WXPUSHER_SPT 或 --config 读取。--test 会发送真实微信通知。");
    return;
  }
  const dry = Boolean(options["--dry-run"]);
  if (dry && options["--test"]) throw new Error("--dry-run 不能与 --test 同时使用");
  const detected = [fs.existsSync(CODEX_DIR) && "codex", fs.existsSync(PI_DIR) && "pi"].filter(Boolean);
  let agent = options["--agent"] || (detected.length === 2 ? "both" : detected[0]);
  const interactive = !dry && !options["--non-interactive"] && process.stdin.isTTY && process.stdout.isTTY;
  let rl;
  let muted = false;
  if (interactive) {
    rl = createInterface({ input: process.stdin, output: new Writable({
      write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); },
    }), terminal: true });
  }
  let targets;
  let configs;
  try {
    if (rl && !options["--agent"]) agent = (await rl.question(`安装到 codex / pi / both [${agent || "both"}]：`)).trim().toLowerCase() || agent || "both";
    if (!["codex", "pi", "both"].includes(agent)) throw new Error("请指定 --agent codex、pi 或 both");
    targets = agent === "both" ? ["codex", "pi"] : [agent];
    const dirs = { codex: CODEX_DIR, pi: PI_DIR };
    const sourcePath = options["--config"] ? path.resolve(options["--config"]) : path.join(HERE, "wxpusher.json");
    const source = readJson(sourcePath, null);
    if (options["--config"] && !source) throw new Error(`${sourcePath} 不存在`);
    const existing = Object.fromEntries(targets.map((target) => [target, readJson(path.join(dirs[target], "wxpusher.json"))]));
    // Old Pi installations shared Codex's config. Copy, never delete that config.
    if (targets.includes("pi") && !fs.existsSync(path.join(PI_DIR, "wxpusher.json"))) {
      if (existing.codex) existing.pi = existing.codex;
      else if (!source && !process.env.WXPUSHER_SPT) existing.pi = readJson(path.join(CODEX_DIR, "wxpusher.json"));
    }
    let spt = process.env.WXPUSHER_SPT;
    let host = options["--host"];
    if (rl) {
      const hasSpt = Boolean(spt || source?.spt || existing[targets[0]].spt);
      process.stdout.write(`WxPusher SPT（输入隐藏${hasSpt ? "，回车沿用已有值" : ""}）：`);
      muted = true;
      try { spt = (await rl.question("")).trim() || spt; }
      finally { muted = false; process.stdout.write("\n"); }
      if (host === undefined) {
        const fallback = existing[targets[0]].host || source?.host || os.hostname();
        host = (await rl.question(`机器名 [${fallback}]：`)).trim() || fallback;
      }
    }
    configs = targets.map((target) => {
      const next = { ...existing[target], ...source };
      // Machine-specific settings survive updates from a repository config.
      for (const field of ["host", "proxy", "node"]) {
        const value = field === "host" ? host : options[`--${field}`];
        next[field] = value ?? existing[target][field] ?? source?.[field];
      }
      if (spt !== undefined) next.spt = spt.trim();
      if (typeof next.spt !== "string" || !next.spt.trim() || next.spt.trim() === "SPT_xxxx") throw new Error("请填写有效的 SPT：交互输入、设置 WXPUSHER_SPT，或使用 --config");
      next.spt = next.spt.trim();
      next.host = next.host || os.hostname();
      next.node = next.node || process.execPath;
      for (const field of ["host", "proxy", "node"]) {
        if (next[field] !== undefined && typeof next[field] !== "string") throw new Error(`${field} 必须是字符串`);
      }
      if (!path.isAbsolute(next.node) || !fs.existsSync(next.node) || !fs.statSync(next.node).isFile()) throw new Error("--node 必须是存在的 Node 可执行文件的绝对路径");
      return { target, dir: dirs[target], config: next, previousNode: existing[target].node };
    });
  } finally {
    rl?.close();
  }

  // Preflight all hook data and source files before any deployment write.
  const sender = fs.readFileSync(path.join(HERE, SCRIPT_NAME), "utf8");
  const extension = targets.includes("pi") ? fs.readFileSync(path.join(HERE, EXT_NAME), "utf8") : "";
  const hooksPath = path.join(CODEX_DIR, "hooks.json");
  let hooksText;
  if (targets.includes("codex")) {
    const hooks = readJson(hooksPath);
    const groups = hooks.hooks?.Stop === undefined ? [] : hooks.hooks.Stop;
    if ((hooks.hooks !== undefined && (!hooks.hooks || typeof hooks.hooks !== "object" || Array.isArray(hooks.hooks))) ||
        !Array.isArray(groups) || groups.some((group) => !group || typeof group !== "object" || !Array.isArray(group.hooks) || group.hooks.some((hook) => !hook || typeof hook !== "object"))) {
      throw new Error(`${hooksPath} 的 hooks / Stop 结构无效；未修改任何文件`);
    }
    const script = path.join(CODEX_DIR, SCRIPT_NAME);
    const { config, previousNode } = configs.find((item) => item.target === "codex");
    const command = `${quote(config.node || process.execPath)} ${quote(script)}`;
    const legacy = `node "${script}"`;
    const previous = previousNode ? `${quote(previousNode)} ${quote(script)}` : command;
    const registered = groups.flatMap((group) => group.hooks).find((hook) => hook.type === "command" &&
      [legacy, command, previous].includes(hook.command));
    if (!registered) {
      hooks.hooks = { ...hooks.hooks, Stop: [...groups, { hooks: [{ type: "command", command }] }] };
      hooksText = JSON.stringify(hooks, null, 2) + "\n";
    } else if (options["--node"] !== undefined && registered.command !== command) {
      registered.command = command;
      hooksText = JSON.stringify(hooks, null, 2) + "\n";
    }
  }
  const actions = [];
  function write(file, text, mode = 0o600) {
    const changed = !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text;
    actions.push(`${changed ? "*" : "="} ${file}`);
    if (!changed || dry) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode });
    if (process.platform !== "win32") fs.chmodSync(file, mode);
  }
  for (const { target, dir, config } of configs) {
    write(path.join(dir, "wxpusher.json"), JSON.stringify(config, null, 2) + "\n");
    write(path.join(dir, SCRIPT_NAME), sender);
    if (target === "pi") write(path.join(dir, "extensions", EXT_NAME), extension);
  }
  if (hooksText) write(hooksPath, hooksText);
  else if (targets.includes("codex")) actions.push(`= ${hooksPath}（Stop hook 已注册）`);
  console.log(dry ? "[wxpusher] DRY-RUN：未写入任何文件" : "[wxpusher] 配置完成：");
  for (const line of actions) console.log(`  ${line}`);
  if (dry) return;
  if (targets.includes("codex")) console.log("[wxpusher] 在 Codex 中用 /hooks 审阅、信任并启用通知 hook；安装不会绕过信任检查。");
  if (targets.includes("pi")) console.log("[wxpusher] Pi 请 /reload 或重开会话以加载扩展（需支持 agent_settled）。");
  let test = Boolean(options["--test"]);
  if (interactive && !test) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { test = /^(y|yes)$/i.test((await prompt.question("现在发送真实微信测试通知？[y/N]：")).trim()); }
    finally { prompt.close(); }
  }
  if (test) {
    for (const { target, dir, config } of configs) {
      const result = spawnSync(config.node || process.execPath, [path.join(dir, SCRIPT_NAME), "--test", "--agent", target === "pi" ? "Pi" : "Codex"], { stdio: "inherit", windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`${target} 测试推送失败；配置已保留，可重试 --test`);
    }
  }
}

try { await main(); }
catch (error) { console.error(`[wxpusher] ${error.message}`); process.exitCode = 1; }
