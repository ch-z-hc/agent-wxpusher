// Offline regression checks; all deployment paths and HTTP calls are isolated.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wxpusher-test-"));
process.on("exit", () => {
  // Only remove the exact temporary directory created by this test process.
  if (path.dirname(fs.realpathSync(sandbox)) === fs.realpathSync(os.tmpdir()) && path.basename(sandbox).startsWith("wxpusher-test-")) fs.rmSync(sandbox, { recursive: true });
});

function fixture(name, interactiveAnswers) {
  const root = path.join(sandbox, name);
  const repo = path.join(root, "repo with spaces 中文 #");
  const home = path.join(root, "home");
  const codex = path.join(home, ".codex");
  const pi = path.join(home, ".pi", "agent");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
  for (const file of ["install.mjs", "send-wxpusher-stop.mjs", "codex-stop-wxpusher.ts"]) fs.copyFileSync(path.join(HERE, file), path.join(repo, file));
  const log = path.join(root, "requests.jsonl");
  const preload = path.join(root, "preload.mjs");
  fs.writeFileSync(preload, `
import os from "node:os";
import fs from "node:fs";
import readline from "node:readline/promises";
import { syncBuiltinESMExports } from "node:module";
os.homedir = () => ${JSON.stringify(home)};
os.tmpdir = () => ${JSON.stringify(path.join(home, "tmp"))};
if (${Boolean(interactiveAnswers)}) {
  Object.defineProperty(process.stdin, "isTTY", { value: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true });
  const answers = ${JSON.stringify(interactiveAnswers || [])};
  readline.createInterface = ({output}) => ({
    async question(prompt) {
      output.write(prompt);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected question");
      output.write(answer + "\\n");
      return answer;
    }, close() {},
  });
}
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({url, body}) + "\\n");
  if (process.env.WX_TEST_FAIL) throw new Error("SPT_do_not_print");
  if (url.endsWith("/chat/completions")) return { ok: true, json: async () => ({ choices: [{ message: { content: "模拟任务摘要" } }] }) };
  if (url !== "https://wxpusher.zjiecode.com/api/send/message/simple-push") throw new Error("unexpected endpoint");
  return { ok: true, json: async () => ({code: 1000}) };
};
`);
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  for (const key of ["CODEX_HOME", "PI_CODING_AGENT_DIR", "WXPUSHER_SPT", "WXPUSHER_SYNC", "WXPUSHER_SUMMARIZE_ONLY", "CODEX_STOP_WXPUSHER_DRY_RUN", "WXPUSHER_AGENT"]) delete env[key];
  function run(args = [], extraEnv = {}, input = "", script = path.join(repo, "install.mjs")) {
    return spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extraEnv }, input, encoding: "utf8", timeout: 10_000, windowsHide: true });
  }
  function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
  function requests() { return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []; }
  return { repo, home, codex, pi, env, run, write, requests };
}

const credentials = { WXPUSHER_SPT: "SPT_offline_fixture" };
function succeeds(result) { assert.equal(result.status, 0, result.stderr || result.error?.message); }

test("both targets install independently and repeat without rewriting hooks", () => {
  const f = fixture("both");
  const args = ["--agent", "both", "--host", "laptop", "--non-interactive"];
  succeeds(f.run(args, credentials));
  for (const dir of [f.codex, f.pi]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "wxpusher.json"))).host, "laptop");
    assert.equal(fs.readFileSync(path.join(dir, "send-wxpusher-stop.mjs"), "utf8"), fs.readFileSync(path.join(HERE, "send-wxpusher-stop.mjs"), "utf8"));
  }
  assert.ok(fs.existsSync(path.join(f.pi, "extensions", "codex-stop-wxpusher.ts")));
  const hooksPath = path.join(f.codex, "hooks.json");
  const bytes = fs.readFileSync(hooksPath, "utf8");
  const mtime = fs.statSync(hooksPath).mtimeMs;
  const second = f.run(args, credentials);
  succeeds(second);
  assert.equal(fs.readFileSync(hooksPath, "utf8"), bytes);
  assert.equal(fs.statSync(hooksPath).mtimeMs, mtime);
  assert.equal(JSON.parse(bytes).hooks.Stop.length, 1);
  assert.match(second.stdout, /Stop hook 已注册/);
  assert.equal(f.requests().length, 0);
});

test("Pi-only setup and explicit test do not require Codex or a model call", () => {
  const f = fixture("pi only");
  succeeds(f.run(["--agent", "pi", "--test", "--non-interactive"], credentials));
  assert.equal(fs.existsSync(f.codex), false);
  assert.equal(f.requests().length, 1);
  assert.match(f.requests()[0].body.content, /Pi.*\nWxPusher 测试通知/s);
});

test("the registered hook command executes through the platform shell with spaces and quotes", () => {
  const f = fixture("shell 'quoted' path");
  succeeds(f.run(["--agent", "codex", "--non-interactive"], credentials));
  const command = JSON.parse(fs.readFileSync(path.join(f.codex, "hooks.json"))).hooks.Stop[0].hooks[0].command;
  const result = spawnSync(command, { shell: true, env: { ...f.env, WXPUSHER_SYNC: "1" }, input: JSON.stringify({ last_assistant_message: "shell 通知" }), encoding: "utf8", timeout: 10_000, windowsHide: true });
  succeeds(result);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(f.requests().length, 1);
});

test("Pi setup with explicit credentials ignores unrelated broken Codex config", () => {
  const f = fixture("pi independence");
  f.write(path.join(f.codex, "wxpusher.json"), "broken codex config");
  succeeds(f.run(["--agent", "pi", "--non-interactive"], credentials));
  assert.equal(fs.readFileSync(path.join(f.codex, "wxpusher.json"), "utf8"), "broken codex config");
  assert.equal(fs.existsSync(path.join(f.codex, "hooks.json")), false);
});

test("dry run writes nothing, and dry run cannot send a test", () => {
  const f = fixture("dry");
  succeeds(f.run(["--agent", "both", "--dry-run"], credentials));
  assert.equal(fs.existsSync(f.codex), false);
  assert.equal(fs.existsSync(f.pi), false);
  assert.equal(f.run(["--agent", "both", "--dry-run", "--test"], credentials).status, 1);
  assert.equal(f.requests().length, 0);
});

test("invalid hooks abort before changing any deployment file and hide secrets", () => {
  for (const [index, value] of ['{"secret":"SPT_do_not_print",', { hooks: [] }, { hooks: { Stop: null } }, { hooks: { Stop: [{ hooks: null }] } }].entries()) {
    const f = fixture(`bad hooks ${index}`);
    const file = path.join(f.codex, "hooks.json");
    f.write(file, value);
    const bytes = fs.readFileSync(file, "utf8");
    const result = f.run(["--agent", "both", "--non-interactive"], credentials);
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    assert.equal(fs.existsSync(path.join(f.codex, "wxpusher.json")), false);
    assert.equal(fs.existsSync(f.pi), false);
    assert.doesNotMatch(result.stderr, /SPT_do_not_print/);
  }
});

test("existing hooks and per-machine config survive a credential update", () => {
  const f = fixture("preserve");
  const oldHook = { description: "keep", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }], Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo done" }] }] } };
  f.write(path.join(f.codex, "hooks.json"), oldHook);
  f.write(path.join(f.codex, "wxpusher.json"), { spt: "SPT_old", host: "old-host", proxy: "http://127.0.0.1:7897", summary: { model: "fixture-model", api_key: "fixture-key", base_url: "https://summary.invalid/v1" } });
  f.write(path.join(f.repo, "wxpusher.json"), { spt: "SPT_new" });
  succeeds(f.run(["--agent", "codex", "--non-interactive"]));
  const config = JSON.parse(fs.readFileSync(path.join(f.codex, "wxpusher.json")));
  assert.equal(config.spt, "SPT_new");
  assert.equal(config.host, "old-host");
  assert.equal(config.proxy, "http://127.0.0.1:7897");
  assert.equal(config.summary.model, "fixture-model");
  const hooks = JSON.parse(fs.readFileSync(path.join(f.codex, "hooks.json")));
  assert.deepEqual(hooks.hooks.SessionStart, oldHook.hooks.SessionStart);
  assert.deepEqual(hooks.hooks.Stop[0], oldHook.hooks.Stop[0]);
  assert.equal(hooks.hooks.Stop.length, 2);
});

test("legacy Pi credentials migrate without changing the old Codex files", () => {
  const f = fixture("legacy pi");
  const file = path.join(f.codex, "wxpusher.json");
  f.write(file, { spt: "SPT_legacy", host: "legacy-host", summary: { model: "keep" } });
  const bytes = fs.readFileSync(file, "utf8");
  succeeds(f.run(["--agent", "pi", "--non-interactive"]));
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.pi, "wxpusher.json"))).summary.model, "keep");
  assert.equal(fs.existsSync(path.join(f.codex, "hooks.json")), false);
});

test("legacy Codex command retains exact hook bytes; --node changes only our handler", () => {
  const f = fixture("legacy hook");
  const file = path.join(f.codex, "hooks.json");
  const command = `node "${path.join(f.codex, "send-wxpusher-stop.mjs")}"`;
  const hook = { type: "command", command, timeout: 5 };
  f.write(file, { hooks: { Stop: [{ hooks: [hook] }] } });
  const bytes = fs.readFileSync(file, "utf8");
  succeeds(f.run(["--agent", "codex", "--non-interactive"], credentials));
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  succeeds(f.run(["--agent", "codex", "--node", process.execPath, "--non-interactive"], credentials));
  const groups = JSON.parse(fs.readFileSync(file)).hooks.Stop;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hooks[0].timeout, 5);
  assert.notEqual(groups[0].hooks[0].command, command);
});

test("bad configs and unknown options fail without deployment or credential disclosure", () => {
  const f = fixture("bad config");
  const file = path.join(f.repo, "wxpusher.json");
  f.write(file, '{"spt":"SPT_do_not_print",');
  const result = f.run(["--agent", "both", "--non-interactive"]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /SPT_do_not_print/);
  assert.equal(fs.existsSync(f.codex), false);
  assert.equal(f.run(["--unknown"]).status, 1);
  assert.equal(f.run(["--agent"]).status, 1);
  const clean = fixture("missing spt");
  assert.equal(clean.run(["--agent", "pi", "--non-interactive"]).status, 1);
  succeeds(clean.run(["--help"]));
  assert.equal(fs.existsSync(clean.pi), false);
});

test("interactive setup hides the SPT and needs no repository JSON", () => {
  const f = fixture("interactive", ["both", "SPT_hidden_fixture", "desktop", "n"]);
  const result = f.run();
  succeeds(result);
  assert.doesNotMatch(result.stdout + result.stderr, /SPT_hidden_fixture/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.codex, "wxpusher.json"))).spt, "SPT_hidden_fixture");
  assert.equal(f.requests().length, 0);
});

test("interactive test consent sends the selected agent notification", () => {
  const f = fixture("interactive test", ["pi", "SPT_hidden_fixture", "desktop", "y"]);
  succeeds(f.run());
  assert.equal(f.requests().length, 1);
  assert.match(f.requests()[0].body.content, /Pi/);
});

test("installer reports test failure and keeps the installed configuration", () => {
  const f = fixture("install test failure");
  const result = f.run(["--agent", "pi", "--test", "--non-interactive"], { ...credentials, WX_TEST_FAIL: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /测试推送失败/);
  assert.doesNotMatch(result.stderr, /SPT_do_not_print/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.pi, "wxpusher.json"))).spt, credentials.WXPUSHER_SPT);
});

test("sender test failure is observable but ordinary hook errors never block", () => {
  const f = fixture("sender errors");
  succeeds(f.run(["--agent", "codex", "--non-interactive"], credentials));
  const sender = path.join(f.codex, "send-wxpusher-stop.mjs");
  const failure = f.run(["--test"], { WX_TEST_FAIL: "1" }, "", sender);
  assert.equal(failure.status, 1);
  assert.doesNotMatch(failure.stderr, /SPT_do_not_print/);
  const malformed = f.run([], {}, "not-json", sender);
  succeeds(malformed);
  assert.deepEqual(JSON.parse(malformed.stdout), {});
  const dry = f.run([], { CODEX_STOP_WXPUSHER_DRY_RUN: "1" }, "{}", sender);
  succeeds(dry);
  assert.deepEqual(JSON.parse(dry.stdout), {});
});

test("sender falls back without model credentials, and supports Codex env_key summaries", () => {
  const f = fixture("summary");
  succeeds(f.run(["--agent", "codex", "--non-interactive"], credentials));
  const sender = path.join(f.codex, "send-wxpusher-stop.mjs");
  succeeds(f.run([], { WXPUSHER_SYNC: "1" }, JSON.stringify({ last_assistant_message: "**完成修复**\n详情" }), sender));
  assert.equal(f.requests().length, 1);
  assert.match(f.requests()[0].body.content, /完成修复/);
  f.write(path.join(f.codex, "config.toml"), 'model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://summary.invalid/v1"\nenv_key = "WX_TEST_PROVIDER_KEY"\n');
  succeeds(f.run([], { WXPUSHER_SYNC: "1", WX_TEST_PROVIDER_KEY: "fixture-key" }, JSON.stringify({ last_assistant_message: "完成修复" }), sender));
  assert.equal(f.requests().length, 3);
  assert.equal(f.requests()[1].body.model, "fixture-model");
  assert.match(f.requests()[2].body.content, /模拟任务摘要/);
});

test("detached worker consumes its payload and sends without blocking the hook", async () => {
  const f = fixture("worker");
  succeeds(f.run(["--agent", "pi", "--non-interactive"], credentials));
  const result = f.run(["--agent", "Pi"], {}, JSON.stringify({ last_assistant_message: "后台通知" }), path.join(f.pi, "send-wxpusher-stop.mjs"));
  succeeds(result);
  assert.deepEqual(JSON.parse(result.stdout), {});
  for (let i = 0; i < 50 && f.requests().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.requests().length, 1);
  assert.match(f.requests()[0].body.content, /Pi.*后台通知/s);
  assert.equal(fs.readdirSync(path.join(f.home, "tmp")).length, 0);
});

test("Pi extension sends to its own directory and clears stale round messages", { skip: Number(process.versions.node.split(".")[0]) < 24 }, () => {
  const f = fixture("extension");
  const code = `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
const sent = [];
childProcess.spawn = (bin, args, options) => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (data) => sent.push({bin, args, payload: JSON.parse(data), options});
  child.unref = () => {};
  return child;
};
syncBuiltinESMExports();
const extension = (await import(${JSON.stringify(pathToFileURL(path.join(f.repo, "codex-stop-wxpusher.ts")).href)})).default;
const handlers = {};
extension({ on(event, handler) { handlers[event] = handler; } });
handlers.agent_start();
handlers.message_end({message: {role: "user", content: [{type: "text", text: "构建通知"}]}});
handlers.message_end({message: {role: "assistant", content: [{type: "text", text: "完成"}]}});
await handlers.agent_settled({}, {});
assert.equal(sent[0].args[0], ${JSON.stringify(path.join(f.pi, "send-wxpusher-stop.mjs"))});
assert.equal(sent[0].payload.last_user_message, "构建通知");
assert.equal(sent[0].payload.last_assistant_message, "完成");
assert.equal(sent[0].options.windowsHide, true);
handlers.agent_start();
await handlers.agent_settled({}, {});
assert.equal(sent[1].payload.last_user_message, "");
assert.equal(sent[1].payload.last_assistant_message, "");
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: f.env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  succeeds(result);
});
