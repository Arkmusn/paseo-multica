import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentIssueLink {
  instanceId: string;
  issueId: string;
  issueIdentifier: string;
}

// Paseo agentId <-> Multica 卡片的映射，持久化到 ~/.paseo 下，插件重载后仍在。
const STORE = join(homedir(), ".paseo", "multica-plugin-links.json");
const links = new Map<string, AgentIssueLink>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(STORE)) return;
    const parsed = JSON.parse(readFileSync(STORE, "utf8")) as Record<string, AgentIssueLink>;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.issueId === "string") links.set(key, value);
    }
  } catch {
    // 读取失败时以空映射继续，不影响插件启动。
  }
}

function persist(): void {
  try {
    const dir = dirname(STORE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STORE, JSON.stringify(Object.fromEntries(links), null, 2));
  } catch {
    // 持久化失败仅意味着重载后丢失映射，不阻断当前操作。
  }
}

export function setLink(agentId: string, link: AgentIssueLink): void {
  load();
  links.set(agentId, link);
  persist();
}

export function clearLink(agentId: string): void {
  load();
  links.delete(agentId);
  persist();
}

export function getLink(agentId: string): AgentIssueLink | null {
  load();
  return links.get(agentId) ?? null;
}