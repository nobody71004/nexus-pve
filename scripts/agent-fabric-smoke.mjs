/**
 * Agent Fabric contract test.
 *
 * Nexus PVE ships no hosted model runtime. This harness is the test-side Fabric
 * loop: it advertises the real MCP tool surface to an OpenAI-compatible model,
 * executes the returned tool calls against the bundled MCP server, and feeds
 * the results back. The model is a local mock, so the test needs no API key and
 * never leaves the machine.
 *
 * The model is scripted to make exactly two MCP calls:
 *   hosts.list -> fleet.overview
 *
 * Run after `npm run build`:
 *   npm run smoke:agent-fabric
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer } from "./mock-pve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist-electron", "mcp-server.cjs");
const TOKEN = "smoke@pve!agent=mock-secret";
const HOSTS_TOOL = "hosts.list";
const FLEET_TOOL = "fleet.overview";

// MCP names contain dots; OpenAI function names do not. The fabric advertises a
// sanitized alias and maps it back to the real MCP tool before calling.
const openAiName = (name) => `mcp_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Minimal OpenAI-compatible chat-completions server. It rejects credentials so
 * the test proves no API key is used, and scripts two tool calls followed by a
 * final answer built from the second tool result.
 */
async function startMockOpenAi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        send(404, { error: { message: `no route for ${req.method} ${req.url}`, type: "invalid_request_error" } });
        return;
      }

      const authorization = req.headers.authorization ?? null;
      if (authorization) {
        requests.push({ authorization, body: null });
        send(401, {
          error: { message: "this mock model requires no API key and rejects credentials", type: "authentication_error" },
        });
        return;
      }

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        send(400, { error: { message: `invalid JSON: ${String(error)}`, type: "invalid_request_error" } });
        return;
      }
      requests.push({ authorization, body });

      const toolResults = (body.messages ?? []).filter((message) => message.role === "tool");
      let message;
      if (toolResults.length === 0) {
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_hosts",
              type: "function",
              function: { name: openAiName(HOSTS_TOOL), arguments: "{}" },
            },
          ],
        };
      } else if (toolResults.length === 1) {
        let hosts;
        try {
          hosts = JSON.parse(toolResults[0].content);
        } catch {
          hosts = null;
        }
        const hostId = hosts?.hosts?.[0]?.id;
        if (!hostId) {
          send(422, {
            error: { message: "hosts.list result did not contain a host id", type: "invalid_request_error" },
          });
          return;
        }
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_fleet",
              type: "function",
              function: { name: openAiName(FLEET_TOOL), arguments: JSON.stringify({ host: hostId }) },
            },
          ],
        };
      } else {
        let fleet;
        try {
          fleet = JSON.parse(toolResults[1].content);
        } catch {
          fleet = null;
        }
        if (!fleet?.host?.label || !Array.isArray(fleet?.nodes) || !fleet?.vms) {
          send(422, {
            error: { message: "fleet.overview result was not usable", type: "invalid_request_error" },
          });
          return;
        }
        message = {
          role: "assistant",
          content: `Fleet ${fleet.host.label} is ${fleet.host.health}: ${fleet.nodes.length} nodes, ${fleet.vms.total} guests (${fleet.vms.running} running).`,
        };
      }

      send(200, {
        id: `chatcmpl-fabric-${requests.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "mock-agent-fabric",
        choices: [
          {
            index: 0,
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    })().catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error), type: "server_error" } }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startMcp(env) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message));
        else item.resolve(message.result);
      }
    }
  });
  child.on("close", () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`MCP server exited\n${stderr}`));
    }
    pending.clear();
  });

  const rpc = (method, params, timeoutMs = 60_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  return {
    stderr: () => stderr,
    async initialize() {
      return rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-fabric-smoke", version: "1" },
      });
    },
    async listTools() {
      const result = await rpc("tools/list", {});
      return result?.tools ?? [];
    },
    async callTool(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      const text = result?.content?.[0]?.text ?? "";
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (result?.isError) {
        const message = parsed && typeof parsed === "object" ? parsed.error ?? text : text;
        throw new Error(`MCP ${name} failed: ${message}`);
      }
      return parsed;
    },
    close() {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Agent Fabric loop: model -> tool_calls -> MCP -> tool results -> model.
 * Returns the final assistant text plus every MCP call that was executed.
 */
async function runAgentFabric({ baseUrl, mcp }) {
  const mcpTools = await mcp.listTools();
  const nameMap = new Map();
  const tools = mcpTools.map((tool) => {
    const name = openAiName(tool.name);
    nameMap.set(name, tool.name);
    return {
      type: "function",
      function: {
        name,
        description: tool.description ?? tool.title ?? tool.name,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    };
  });
  if (nameMap.size !== mcpTools.length) throw new Error("sanitized MCP tool names collided");

  const messages = [
    { role: "user", content: "List the configured Proxmox hosts, then summarize the fleet." },
  ];
  const calls = [];
  for (let turn = 0; turn < 8; turn += 1) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-agent-fabric",
        messages,
        tools,
        tool_choice: "auto",
      }),
    });
    if (!response.ok) {
      throw new Error(`mock model returned ${response.status}: ${await response.text()}`);
    }
    const completion = await response.json();
    const message = completion?.choices?.[0]?.message;
    if (!message) throw new Error("mock model returned no assistant message");
    messages.push(message);

    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      return { final: message.content ?? "", calls, messages, tools };
    }
    for (const call of message.tool_calls) {
      const advertised = call.function?.name ?? "";
      const toolName = nameMap.get(advertised);
      if (!toolName) throw new Error(`model called an unadvertised tool: ${advertised}`);
      let args;
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        throw new Error(`model returned invalid arguments for ${advertised}`);
      }
      const result = await mcp.callTool(toolName, args);
      calls.push({ tool: toolName, advertised, args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("mock model did not produce a final answer");
}

const home = mkdtempSync(path.join(tmpdir(), "nexus-agent-fabric-"));
const pve = await startMockServer(0);
const model = await startMockOpenAi();
let mcp = null;

try {
  check("bundled MCP server exists", existsSync(serverPath), serverPath);
  if (!existsSync(serverPath)) throw new Error("run `npm run build` before this test");

  mcp = startMcp({
    ...process.env,
    NEXUS_PVE_HOME: home,
    NEXUS_PVE_URL: pve.url,
    NEXUS_PVE_TOKEN: TOKEN,
    NEXUS_PVE_LABEL: "smoke-lab",
  });
  const init = await mcp.initialize();
  check("MCP initialize identifies nexus-pve", init?.serverInfo?.name === "nexus-pve", init?.serverInfo?.name);

  const fabric = await runAgentFabric({ baseUrl: model.url, mcp });

  check(
    "mock model needed no API key",
    model.requests.length === 3 && model.requests.every((request) => request.authorization === null),
    `${model.requests.length} turns, no Authorization header`,
  );
  check(
    "model was offered the full MCP surface",
    fabric.tools.length >= 60 &&
      fabric.tools.some((tool) => tool.function.name === openAiName(HOSTS_TOOL)) &&
      fabric.tools.some((tool) => tool.function.name === openAiName(FLEET_TOOL)),
    `${fabric.tools.length} tools`,
  );
  check(
    "Agent Fabric drove exactly two MCP tool calls",
    fabric.calls.length === 2 &&
      fabric.calls[0]?.tool === HOSTS_TOOL &&
      fabric.calls[1]?.tool === FLEET_TOOL,
    fabric.calls.map((call) => call.tool).join(" -> "),
  );
  check(
    "first tool call listed the configured host",
    fabric.calls[0]?.result?.hosts?.length === 1 &&
      fabric.calls[0].result.hosts[0].label === "smoke-lab" &&
      !JSON.stringify(fabric.calls[0].result).includes("mock-secret"),
    fabric.calls[0]?.result?.hosts?.[0]?.label,
  );
  check(
    "second tool call returned the live fleet",
    fabric.calls[1]?.result?.host?.health === "online" &&
      fabric.calls[1].result.nodes?.length === 2 &&
      fabric.calls[1].result.vms?.total === 3 &&
      fabric.calls[1].result.vms?.running === 2,
    `${fabric.calls[1]?.result?.nodes?.length} nodes / ${fabric.calls[1]?.result?.vms?.total} guests`,
  );
  check(
    "model received both tool results before answering",
    model.requests[2]?.body?.messages?.filter((message) => message.role === "tool").length === 2,
  );
  check(
    "final answer is built from the MCP results",
    /smoke-lab/.test(fabric.final) && /2 nodes/.test(fabric.final) && /3 guests/.test(fabric.final),
    fabric.final,
  );
  check(
    "mock Proxmox saw both reads and no mutations",
    pve.state.requests.some((request) => request.startsWith("GET /api2/json/nodes")) && pve.state.actions.length === 0,
    `${pve.state.requests.length} requests`,
  );
} catch (error) {
  check("Agent Fabric harness completed without throwing", false, error?.stack ?? String(error));
} finally {
  mcp?.close();
  await model.close();
  await pve.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp profile must not fail the result */
  }
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((entry) => entry.name).join(" | ")}`);
  process.exit(1);
}
