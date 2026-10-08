// WxPusher "task done" push for Pi. Deployed by install.mjs in this folder into
// ~/.pi/agent/extensions/; edit the source copy in the agent-wxpusher repository.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Each agent has its own deployed copy of the same notifier.
const STOP_HOOK = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "send-wxpusher-stop.mjs");

function textOf(message: any): string {
  if (typeof message?.content === "string") return message.content.trim();
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  let lastUser = "";
  let lastAssistant = "";

  pi.on("agent_start", () => {
    lastUser = "";
    lastAssistant = "";
  });

  pi.on("message_end", (event) => {
    const message = event.message as any;
    if (message?.role === "user") {
      // Tool results and injected follow-ups also arrive as user messages; the
      // recap only wants what the human actually asked for.
      if (!message.isMeta && !message.terminal) lastUser = textOf(message) || lastUser;
    } else if (message?.role === "assistant") {
      const text = textOf(message);
      if (text) lastAssistant = text;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const payload: Record<string, unknown> = {
      last_user_message: lastUser,
      last_assistant_message: lastAssistant,
    };
    // Recap defaults to the model that just answered, so keep its endpoint and
    // key alongside the id. Only for OpenAI-style APIs: the recap calls
    // /chat/completions, which an Anthropic-style provider does not serve.
    const model = ctx.model as any;
    if (model?.id && typeof model.api === "string" && model.api.startsWith("openai")) {
      payload.model = model.id;
      let auth: any;
      try {
        auth = await ctx.modelRegistry.getProviderAuth(model.provider);
      } catch { /* fall back to the script's own endpoint lookup */ }
      const baseUrl = model.baseUrl || auth?.auth?.baseUrl;
      const apiKey = auth?.auth?.apiKey;
      if (baseUrl) payload.base_url = baseUrl;
      if (apiKey) payload.api_key = apiKey;
    }
    let nodeBin = process.execPath;
    try {
      const config = JSON.parse(fs.readFileSync(path.join(path.dirname(STOP_HOOK), "wxpusher.json"), "utf8"));
      if (typeof config.node === "string" && config.node.trim()) nodeBin = config.node;
    } catch { /* notifier failures must not affect the agent */ }
    const child = spawn(nodeBin, [STOP_HOOK, "--agent", "Pi"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    // Fire and forget: a dead notifier must never surface in the session.
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  });
}
