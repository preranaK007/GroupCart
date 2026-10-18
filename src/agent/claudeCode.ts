// Runs one coordinator turn with Claude Code in headless mode, signed in with the host's own Claude account
// (no API key). Claude Code gets no shell or file tools: only web search and fetch (to find a GIF, a meme, a fact)
// and GroupCart's tools, over the connector's MCP endpoint with a short-lived token for the roommate being answered.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ClaudeCodeTurn = {
  prompt: string;
  systemPrompt: string;
  mcpUrl: string;
  token: string;
  /** GroupCart tools this run must not use (bare tool names). */
  disallowedTools: string[];
};

const SERVER = "groupcart";
const TIMEOUT_MS = 240_000;

/** Returns Claude's final message, or null when the run failed (logged, never thrown into the chat). */
export async function runClaudeCode(turn: ClaudeCodeTurn, binary = process.env.GROUP_CART_CLAUDE_BIN?.trim() || "claude"): Promise<string | null> {
  // The token goes in a private temp file, not on the command line where other processes could read it.
  const directory = mkdtempSync(join(tmpdir(), "groupcart-coordinator-"));
  try {
    const mcpConfig = join(directory, "mcp.json");
    const systemPrompt = join(directory, "system.md");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: turn.mcpUrl, headers: { Authorization: `Bearer ${turn.token}` } } } }), { mode: 0o600 });
    writeFileSync(systemPrompt, turn.systemPrompt);
    const args = [
      "-p", "--output-format", "json",
      "--system-prompt-file", systemPrompt,
      "--tools", "WebSearch,WebFetch",
      "--strict-mcp-config", "--mcp-config", mcpConfig,
      "--allowedTools", `mcp__${SERVER}`, "WebSearch", "WebFetch",
      ...(turn.disallowedTools.length ? ["--disallowedTools", ...turn.disallowedTools.map((name) => `mcp__${SERVER}__${name}`)] : []),
      "--setting-sources", "",
      "--no-session-persistence",
      "--effort", "low",
    ];
    const output = await run(binary, args, turn.prompt, directory);
    if (output === null) return null;
    const result = JSON.parse(output) as { is_error?: boolean; result?: unknown; subtype?: string };
    if (result.is_error || typeof result.result !== "string") {
      console.warn(`Claude coordinator turn failed (${result.subtype ?? "error"}).`);
      return null;
    }
    return result.result;
  } catch (error) {
    console.warn("Claude coordinator turn failed:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function run(binary: string, args: string[], input: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      console.warn(`Couldn't start Claude Code (${binary}): ${error.message}. Is it installed and signed in?`);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        console.warn(`Claude Code exited with ${code}: ${stderr.trim().slice(0, 300)}`);
        resolve(null);
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}
