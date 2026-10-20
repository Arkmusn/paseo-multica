import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MulticaInstanceConfig, MulticaSettingsValues } from "../shared/model";

export interface ResolvedInstance {
  id: string;
  label: string;
  serverUrl: string;
  appUrl: string;
  workspaceId: string;
  workspaceSlug: string;
  token: string;
  writeBack: boolean;
  isDefault: boolean;
}

interface CliConfig {
  server_url?: string;
  app_url?: string;
  workspace_id?: string;
  token?: string;
}

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// 读取 Multica CLI 的配置文件（默认 ~/.multica/config.json），用于继承 server/app/workspace/token。
export function readCliConfig(configPath: string): CliConfig | null {
  try {
    const full = expandHome(configPath);
    if (!existsSync(full)) return null;
    return JSON.parse(readFileSync(full, "utf8")) as CliConfig;
  } catch {
    return null;
  }
}

function build(inst: MulticaInstanceConfig, isDefault: boolean): ResolvedInstance {
  const cli = readCliConfig(inst.configPath);
  return {
    id: inst.id,
    label: inst.label || inst.id,
    serverUrl: inst.serverUrl || cli?.server_url || "http://localhost:8080",
    appUrl: inst.appUrl || cli?.app_url || "",
    workspaceId: inst.workspaceId || cli?.workspace_id || "",
    workspaceSlug: inst.workspaceSlug || "",
    token: inst.token || cli?.token || "",
    writeBack: inst.writeBack,
    isDefault,
  };
}

export function resolveInstances(values: MulticaSettingsValues): ResolvedInstance[] {
  if (values.instances.length > 0) {
    return values.instances.map((i) => build(i, false));
  }

  // 未配置实例时，自动探测本机 Multica CLI 配置作为默认实例。
  const cli = readCliConfig("~/.multica/config.json");
  if (!cli?.server_url) return [];
  return [
    {
      id: "default",
      label: "本机 Multica",
      serverUrl: cli.server_url,
      appUrl: cli.app_url || "",
      workspaceId: cli.workspace_id || "",
      workspaceSlug: "",
      token: cli.token || "",
      writeBack: false,
      isDefault: true,
    },
  ];
}

export function pickInstance(
  instances: ResolvedInstance[],
  activeId: string,
  requested?: string,
): ResolvedInstance | null {
  if (requested) {
    return instances.find((i) => i.id === requested) ?? null;
  }
  if (activeId) {
    const found = instances.find((i) => i.id === activeId);
    if (found) return found;
  }
  return instances[0] ?? null;
}

export function toPublic(inst: ResolvedInstance) {
  return {
    id: inst.id,
    label: inst.label,
    serverUrl: inst.serverUrl,
    appUrl: inst.appUrl,
    workspaceId: inst.workspaceId,
    workspaceSlug: inst.workspaceSlug,
    writeBack: inst.writeBack,
    hasToken: inst.token.length > 0,
    isDefault: inst.isDefault,
  };
}
// 通过本机 Multica CLI profile 构造实例（看板切换服务端用）。
// name 为空表示默认 profile（~/.multica/config.json）。
export function resolveProfile(name: string, workspaceId?: string): ResolvedInstance | null {
  const root = join(homedir(), ".multica");
  const path = name ? join(root, "profiles", name, "config.json") : join(root, "config.json");
  const cli = readCliConfig(path);
  if (!cli?.server_url) return null;
  return {
    id: `profile:${name || "default"}`,
    label: name || "默认 profile",
    serverUrl: cli.server_url,
    appUrl: cli.app_url || "",
    workspaceId: workspaceId || cli.workspace_id || "",
    workspaceSlug: "",
    token: cli.token || "",
    writeBack: false,
    isDefault: !name,
  };
}

export interface CliProfileSummary {
  name: string;
  label: string;
  serverUrl: string;
  appUrl: string;
  workspaceId: string;
}

// 枚举本机所有已登录（有 server_url）的 CLI profile。
export function listCliProfiles(): CliProfileSummary[] {
  const root = join(homedir(), ".multica");
  const out: CliProfileSummary[] = [];

  const push = (name: string): void => {
    const path = name ? join(root, "profiles", name, "config.json") : join(root, "config.json");
    const cli = readCliConfig(path);
    if (!cli?.server_url) return;
    out.push({
      name,
      label: name || "默认 profile",
      serverUrl: cli.server_url,
      appUrl: cli.app_url || "",
      workspaceId: cli.workspace_id || "",
    });
  };

  push("");
  try {
    const dir = join(root, "profiles");
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) push(entry.name);
      }
    }
  } catch {
    // 忽略：只返回默认 profile。
  }
  return out;
}
