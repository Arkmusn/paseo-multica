import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  constants,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { MulticaSettingsSchema, type RuntimeSettingsValues } from "../shared/model";
import {
  profileCreateRpc,
  profilesListRpc,
  runtimeProvisionRpc,
  runtimeStatusRpc,
  runtimeTeardownRpc,
  type Profile,
  type ProvisionStep,
  type ProvisionResult,
  type RuntimeStatus,
} from "../shared/provision";

const WRAPPER_TIMEOUT = 30_000;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// 用登录 shell 解析可执行文件，模拟 daemon 的 PATH 回退行为。
function resolveBinary(name: string): string {
  const shell = process.env.SHELL || "/bin/sh";
  try {
    const res = spawnSync(shell, ["-lc", `command -v ${name}`], { encoding: "utf8", timeout: 10_000 });
    const out = (res.stdout ?? "").trim().split("\n").pop() ?? "";
    return out;
  } catch {
    return "";
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// 从 Paseo 插件进程继承的环境里剔除 Paseo 自己的 provider 注入。
// 否则 `multica daemon restart` 会把这些变量带给 Multica daemon，
// 之后 Multica 拉起的 opencode 就会加载 Paseo 的 bridge 插件，报
// “OpenCode session is not bound to a Paseo agent”。
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE",
    "OPENCODE_PID",
    "PASEO_AGENT_ID",
    "PASEO_AGENT_CWD",
    "PASEO_HOME",
    "PASEO_CLI",
    "PASEO_ACP_MODE",
    "PASEO_PROVIDER",
    "PASEO_MULTICA_PROJECT_ROOT",
    "__CFBundleIdentifier",
    "_CI___CFBundleIdentifier",
  ]) {
    delete env[key];
  }
  return env;
}

// profile 非空时作为全局标志前置：multica --profile <p> <sub...>
function runMultica(bin: string, args: string[], profile?: string): { ok: boolean; stdout: string; stderr: string } {
  const full = profile && profile.trim() ? ["--profile", profile.trim(), ...args] : args;
  const res = spawnSync(bin, full, { encoding: "utf8", timeout: WRAPPER_TIMEOUT, env: cleanEnv() });
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function multicaJson<T>(bin: string, args: string[], profile?: string): T | null {
  const res = runMultica(bin, [...args, "--output", "json"], profile);
  if (!res.ok || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    return null;
  }
}

// 插件安装根目录：优先从 Paseo 配置读取（server 代码运行时 import.meta.url 不可用），
// 其次退回源码目录（本地目录安装且直接加载时）。
function pluginRoot(): string | null {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  try {
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: string }>;
    };
    const path = cfg.plugins?.["paseo-multica"]?.path;
    if (typeof path === "string" && path.trim()) return path;
  } catch {
    // 配置不可读时退回源码路径。
  }
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
}

// 随插件分发的单文件 harness 候选路径：<plugin>/vendor/… 与已安装 npm 插件的 node_modules。
function vendoredHarnessCandidates(): string[] {
  const out: string[] = [];
  const root = pluginRoot();
  if (root) out.push(join(root, "vendor", "paseo-acp-harness.cjs"));

  const listDirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  };

  const base = join(homedir(), ".paseo", "plugins");
  for (const id of listDirs(base)) {
    for (const install of listDirs(join(base, id))) {
      const installDir = join(base, id, install);
      out.push(join(installDir, "vendor", "paseo-acp-harness.cjs"));
      for (const pkg of listDirs(join(installDir, "node_modules"))) {
        out.push(join(installDir, "node_modules", pkg, "vendor", "paseo-acp-harness.cjs"));
      }
    }
  }
  return out;
}

// 默认 harness 路径：优先配置，其次环境变量，再次随插件分发的单文件，最后按开发目录探测。
function resolveHarnessPath(cfg: RuntimeSettingsValues): string {
  if (cfg.harnessPath.trim()) return expandHome(cfg.harnessPath.trim());
  const env = process.env.PASEO_MULTICA_HARNESS;
  if (env && env.trim()) return expandHome(env.trim());
  const candidates = [
    ...vendoredHarnessCandidates(),
    join(homedir(), "projects", "playground", "paseo-acp-harness", "dist", "index.js"),
    "/opt/paseo-acp-harness/dist/index.js",
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// 选一个可写的 PATH 目录；create=true 时顺带创建（用于安装）。
function detectBinDir(cfg: RuntimeSettingsValues, multicaBin: string, create: boolean): string {
  const candidates: string[] = [];
  if (cfg.binDir.trim()) candidates.push(expandHome(cfg.binDir.trim()));
  // 优先 multica 二进制所在目录：daemon 一定在 PATH 上解析得到它。
  if (multicaBin) candidates.push(dirname(multicaBin));
  candidates.push(join(homedir(), ".local", "bin"));
  candidates.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of candidates) {
    if (create && !existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        continue;
      }
    }
    if (existsSync(dir) && isWritable(dir)) return dir;
  }
  return "";
}

function wrapperPathFor(binDir: string, commandName: string): string {
  return join(binDir, commandName);
}

// 解析真实的 node 可执行文件。注意：插件服务端跑在 Paseo 的 Electron 里，
// process.execPath 是 Paseo Helper（Electron），不是 node，不能直接拿来当解释器。
function resolveNode(): string {
  const viaShell = resolveBinary("node");
  if (viaShell) return viaShell;
  const base = process.execPath.split("/").pop() ?? "";
  return /^node(\.exe)?$/.test(base) ? process.execPath : "node";
}

function wrapperScript(harnessPath: string, provider: string): string {
  // 用绝对 node 路径，避免 daemon 的 PATH 里没有 node；
  // 若配置了 provider，注入 PASEO_PROVIDER 作为无 agent 模型时的兜底默认。
  const node = resolveNode();
  const env = provider && provider.trim() ? `PASEO_PROVIDER=${shellQuote(provider.trim())}\n` : "";
  return `#!/bin/sh\n${env}exec ${shellQuote(node)} ${shellQuote(harnessPath)} "$@"\n`;
}

function writeWrapper(wrapperPath: string, harnessPath: string, provider: string): void {
  writeFileSync(wrapperPath, wrapperScript(harnessPath, provider), { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);
}

interface ProfileRow {
  id: string;
  command_name: string;
  protocol_family: string;
  display_name: string;
}
interface RuntimeRow {
  id: string;
  launch_header: string;
  status: string;
  profile_id: string | null;
}
interface AgentRow {
  id: string;
  name: string;
  archived_at: string | null;
  runtime_id?: string;
}

function findProfile(bin: string, commandName: string, profile?: string): ProfileRow | null {
  const rows = multicaJson<ProfileRow[]>(bin, ["runtime", "profile", "list"], profile);
  if (!rows) return null;
  return rows.find((p) => p.command_name === commandName) ?? null;
}

function findRuntimeForProfile(bin: string, profileId: string, profile?: string): RuntimeRow | null {
  const rows = multicaJson<RuntimeRow[]>(bin, ["runtime", "list"], profile);
  if (!rows) return null;
  return rows.find((r) => r.profile_id === profileId) ?? null;
}

function listRuntimes(bin: string, profile?: string): RuntimeRow[] {
  return multicaJson<RuntimeRow[]>(bin, ["runtime", "list"], profile) ?? [];
}

function createProfileRow(
  bin: string,
  cfg: RuntimeSettingsValues,
  profile?: string,
): ProfileRow | null {
  const res = runMultica(bin, [
    "runtime", "profile", "create",
    "--command-name", cfg.commandName,
    "--display-name", cfg.displayName,
    "--runtime-type", cfg.runtimeType,
    "--output", "json",
  ], profile);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.stdout) as ProfileRow;
  } catch {
    return findProfile(bin, cfg.commandName, profile);
  }
}

function findAgent(bin: string, name: string, profile?: string): AgentRow | null {
  const rows = multicaJson<AgentRow[]>(bin, ["agent", "list"], profile);
  if (!rows) return null;
  return rows.find((a) => a.name === name && !a.archived_at) ?? null;
}

// 枚举本机 Multica CLI profile：默认位于 ~/.multica/config.json，
// 具名 profile 位于 ~/.multica/profiles/<name>/config.json。
export function listProfiles(): Profile[] {
  const root = join(homedir(), ".multica");
  const out: Profile[] = [];

  const readOne = (name: string, path: string, isDefault: boolean): void => {
    let serverUrl = "";
    let workspaceId = "";
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (typeof raw.server_url === "string") serverUrl = raw.server_url;
      if (typeof raw.workspace_id === "string") workspaceId = raw.workspace_id;
    } catch {
      // 配置损坏或未初始化：仍列出该 profile，只是字段为空。
    }
    out.push({ name, serverUrl, workspaceId, path, isDefault });
  };

  const def = join(root, "config.json");
  if (existsSync(def)) readOne("", def, true);

  const dir = join(root, "profiles");
  if (existsSync(dir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const cfgPath = join(dir, name, "config.json");
      if (existsSync(cfgPath)) readOne(name, cfgPath, false);
    }
  }
  return out;
}

// 新建（或补全）一个具名 profile：写 server/app/workspace，再用 PAT 登录。
export function createProfile(
  multicaBin: string,
  input: { name: string; serverUrl: string; appUrl?: string; workspaceId?: string; token?: string },
): { ok: boolean; steps: ProvisionStep[]; error: string } {
  const name = input.name.trim();
  const steps: ProvisionStep[] = [];
  if (!name) return { ok: false, steps, error: "profile 名称不能为空" };

  const setKey = (key: string, value: string): void => {
    const res = runMultica(multicaBin, ["config", "set", key, value], name);
    steps.push({ name: `profile.${key}`, ok: res.ok, detail: res.ok ? `${key}=${value}` : res.stderr.trim() || "写入失败" });
  };

  setKey("server_url", input.serverUrl.trim());
  if (input.appUrl?.trim()) setKey("app_url", input.appUrl.trim());
  if (input.workspaceId?.trim()) setKey("workspace_id", input.workspaceId.trim());

  if (input.token?.trim()) {
    const res = runMultica(multicaBin, ["login", "--token", input.token.trim()], name);
    steps.push({ name: "profile.login", ok: res.ok, detail: res.ok ? "已用 PAT 登录" : res.stderr.trim() || "登录失败" });
  } else {
    steps.push({ name: "profile.login", ok: false, detail: `未提供 token：需运行 multica --profile ${name} login 完成认证` });
  }

  const configOk = steps.filter((s) => s.name !== "profile.login").every((s) => s.ok);
  return { ok: configOk, steps, error: configOk ? "" : steps.find((s) => !s.ok)?.detail ?? "创建失败" };
}

// 插件升级/安装目录变化后自愈：只在 wrapper 已存在（曾经接入过）时重写，不主动创建。
export async function repairRuntimeWrapper(
  settings: PluginSettings<typeof MulticaSettingsSchema>,
): Promise<void> {
  const state = await settings.read();
  if (state.status !== "ready") return;
  const cfg = state.values.runtime;
  const binDir = detectBinDir(cfg, resolveBinary("multica"), false);
  if (!binDir) return;
  const wrapperPath = wrapperPathFor(binDir, cfg.commandName);
  if (!existsSync(wrapperPath)) return;
  const harnessPath = resolveHarnessPath(cfg);
  if (!existsSync(harnessPath)) return;

  let current = "";
  try {
    current = readFileSync(wrapperPath, "utf8");
  } catch {
    return;
  }
  const desired = wrapperScript(harnessPath, cfg.provider);
  if (current === desired) return;
  writeWrapper(wrapperPath, harnessPath, cfg.provider);
  process.stderr.write(`[paseo-multica] wrapper 已更新 -> ${harnessPath}\n`);
}

// 移除本机接入：只删本插件写的 wrapper，不动 Multica 侧的 runtime/agent。
export function removeWrapper(cfg: RuntimeSettingsValues): { removed: boolean; path: string; error: string } {
  const binDir = detectBinDir(cfg, resolveBinary("multica"), false);
  if (!binDir) return { removed: false, path: "", error: "未找到可写的 PATH 目录" };
  const wrapperPath = wrapperPathFor(binDir, cfg.commandName);
  if (!existsSync(wrapperPath)) return { removed: false, path: wrapperPath, error: "wrapper 不存在" };

  let content = "";
  try {
    content = readFileSync(wrapperPath, "utf8");
  } catch {
    return { removed: false, path: wrapperPath, error: "无法读取 wrapper" };
  }
  if (!content.includes("paseo-acp-harness")) {
    return { removed: false, path: wrapperPath, error: "该文件不是本插件创建的，已跳过" };
  }
  try {
    unlinkSync(wrapperPath);
    return { removed: true, path: wrapperPath, error: "" };
  } catch (e) {
    return { removed: false, path: wrapperPath, error: e instanceof Error ? e.message : String(e) };
  }
}

async function readRuntime(
  settings: PluginSettings<typeof MulticaSettingsSchema>,
): Promise<RuntimeSettingsValues> {
  const state = await settings.read();
  return state.status === "ready" ? state.values.runtime : MulticaSettingsSchema.parse({}).runtime;
}

export async function computeStatus(cfg: RuntimeSettingsValues): Promise<RuntimeStatus> {
  const profileName = (cfg.profile ?? "").trim();
  const multicaBin = resolveBinary("multica");
  const harnessPath = resolveHarnessPath(cfg);
  const harnessPresent = existsSync(harnessPath);
  const binDir = detectBinDir(cfg, multicaBin, false);
  const wrapperPath = binDir ? wrapperPathFor(binDir, cfg.commandName) : "";

  let profile: RuntimeStatus["profile"] = null;
  let runtime: RuntimeStatus["runtime"] = null;
  let agent: RuntimeStatus["agent"] = null;
  let error: string | null = null;

  if (!multicaBin) {
    error = "未找到 multica CLI：请先安装并登录（在终端运行 multica setup）。";
  } else {
    try {
      const p = findProfile(multicaBin, cfg.commandName, profileName);
      if (p) {
        profile = { id: p.id, commandName: p.command_name, protocolFamily: p.protocol_family, displayName: p.display_name };
        const r = findRuntimeForProfile(multicaBin, p.id, profileName);
        if (r) runtime = { id: r.id, launchHeader: r.launch_header, status: r.status };
      }
      const a = findAgent(multicaBin, cfg.agentName, profileName);
      if (a) agent = { id: a.id, name: a.name };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    profileName,
    multicaCli: { present: !!multicaBin, path: multicaBin },
    harness: { present: harnessPresent, path: harnessPath },
    binDir: { path: binDir, writable: binDir ? isWritable(binDir) : false },
    wrapper: { path: wrapperPath, present: wrapperPath ? existsSync(wrapperPath) : false },
    profile,
    runtime,
    agent,
    error,
  };
}

export async function computeProvision(
  cfg: RuntimeSettingsValues,
  restart: boolean | undefined,
  profileOverride?: string,
): Promise<ProvisionResult> {
  const steps: ProvisionStep[] = [];
  const add = (name: string, ok: boolean, detail: string) => steps.push({ name, ok, detail });

  const profileName = (profileOverride ?? cfg.profile ?? "").trim();
  add("Multica profile", true, profileName || "（默认 profile）");

  const multicaBin = resolveBinary("multica");
  add("定位 multica CLI", !!multicaBin, multicaBin || "未找到 multica CLI（请先运行 multica setup）");
  if (!multicaBin) return { ok: false, steps, profileId: "", runtimeId: "", agentId: "" };

  const harnessPath = resolveHarnessPath(cfg);
  const harnessPresent = existsSync(harnessPath);
  add("定位 harness", harnessPresent, harnessPath);
  if (!harnessPresent) return { ok: false, steps, profileId: "", runtimeId: "", agentId: "" };

  const binDir = detectBinDir(cfg, multicaBin, true);
  add("选择 PATH 目录", !!binDir, binDir || "没有可写的 PATH 目录（可在设置里指定 binDir）");
  if (!binDir) return { ok: false, steps, profileId: "", runtimeId: "", agentId: "" };

  const wrapperPath = wrapperPathFor(binDir, cfg.commandName);
  try {
    writeWrapper(wrapperPath, harnessPath, cfg.provider);
    add("写入 wrapper", true, `${wrapperPath}（node=${resolveNode()}${cfg.provider ? `，PASEO_PROVIDER=${cfg.provider}` : ""}）`);
  } catch (e) {
    add("写入 wrapper", false, e instanceof Error ? e.message : String(e));
    return { ok: false, steps, profileId: "", runtimeId: "", agentId: "" };
  }

  // 幂等注册 profile。协议族不可修改：若已存在的 profile 族与目标不一致，则迁移——
  // 先建新族的 profile（下面统一重启），重启后再重绑 agent 并删除旧 profile。
  let profile = findProfile(multicaBin, cfg.commandName, profileName);
  let migrationFrom: ProfileRow | null = null;
  if (profile && profile.protocol_family !== cfg.runtimeType) {
    migrationFrom = profile;
    const created = createProfileRow(multicaBin, cfg, profileName);
    if (!created) {
      add("迁移 runtime profile", false, `无法创建目标族 ${cfg.runtimeType} 的 profile`);
      return { ok: false, steps, profileId: "", runtimeId: "", agentId: "" };
    }
    profile = created;
    add("迁移 runtime profile", true, `协议族 ${migrationFrom.protocol_family} → ${cfg.runtimeType}：新 profile ${created.id}`);
  } else if (profile) {
    add("注册 runtime profile", true, `已存在：${profile.id}（${profile.protocol_family}）`);
  } else {
    const created = createProfileRow(multicaBin, cfg, profileName);
    if (!created) {
      add("注册 runtime profile", false, "create 失败");
      return { ok: false, steps, profileId: "", runtimeId: "", agentId: "" };
    }
    profile = created;
    add("注册 runtime profile", true, `已创建：${profile.id}（${profile.protocol_family}）`);
  }
  if (!profile) return { ok: false, steps, profileId: "", runtimeId: "", agentId: "" };

  // 重启 daemon，让新 profile 生效。
  const shouldRestart = restart ?? cfg.restartDaemon;
  if (shouldRestart) {
    const res = runMultica(multicaBin, ["daemon", "restart"], profileName);
    add("重启 Multica daemon", res.ok, res.ok ? "已重启" : (res.stderr || res.stdout).trim() || "重启失败（可手动重启）");
  } else {
    add("重启 Multica daemon", true, "已按设置跳过（需手动重启才生效）");
  }

  // 找到绑定该 profile 的 runtime。
  let runtime = findRuntimeForProfile(multicaBin, profile.id, profileName);
  if (!runtime) {
    add("解析对应 runtime", false, "runtime 尚未出现（daemon 可能还在启动，稍后重试或刷新状态）");
    return { ok: false, steps, profileId: profile.id, runtimeId: "", agentId: "" };
  }
  add("解析对应 runtime", true, `${runtime.id}（${runtime.launch_header} · ${runtime.status}）`);

  // 迁移收尾：把绑在旧 profile 的 runtime 上的 agent 重绑到新 runtime，再删旧 profile。
  if (migrationFrom) {
    const old = migrationFrom;
    const oldRuntimeIds = new Set(
      listRuntimes(multicaBin, profileName)
        .filter((r) => r.profile_id === old.id)
        .map((r) => r.id),
    );
    const agents = multicaJson<AgentRow[]>(multicaBin, ["agent", "list"], profileName) ?? [];
    const toRebind = agents.filter((a) => a.runtime_id && oldRuntimeIds.has(a.runtime_id) && !a.archived_at);
    add("查找待重绑 agent", true, toRebind.length ? toRebind.map((a) => a.name).join("、") : "无（无 agent 绑定旧 runtime）");

    let allOk = true;
    for (const a of toRebind) {
      const res = runMultica(multicaBin, ["agent", "update", a.id, "--runtime-id", runtime.id], profileName);
      if (!res.ok) allOk = false;
      add(`重绑 agent ${a.name}`, res.ok, res.ok ? `→ ${runtime.id}` : (res.stderr || res.stdout).trim());
    }
    if (!allOk) {
      add("删除旧 profile", false, "仍有 agent 未重绑成功，已保留旧 profile");
      return { ok: false, steps, profileId: profile.id, runtimeId: runtime.id, agentId: "" };
    }
    const del = runMultica(multicaBin, ["runtime", "profile", "delete", old.id], profileName);
    add(
      "删除旧 profile",
      del.ok,
      del.ok ? `已删除 ${old.id}（${old.protocol_family}）` : (del.stderr || del.stdout).trim(),
    );
  }

  // 幂等注册 agent。
  let agent = findAgent(multicaBin, cfg.agentName, profileName);
  if (agent) {
    add("注册 agent", true, `已存在：${agent.id}`);
  } else {
    const res = runMultica(multicaBin, [
      "agent", "create",
      "--name", cfg.agentName,
      "--runtime-id", runtime.id,
      "--output", "json",
    ], profileName);
    if (!res.ok) {
      add("注册 agent", false, (res.stderr || res.stdout).trim() || "create 失败");
      return { ok: false, steps, profileId: profile.id, runtimeId: runtime.id, agentId: "" };
    }
    try {
      agent = JSON.parse(res.stdout) as AgentRow;
    } catch {
      agent = findAgent(multicaBin, cfg.agentName, profileName);
    }
    add("注册 agent", !!agent, agent ? `已创建：${agent.id}` : "创建后未读到 agent");
  }

  const ok = !!profile && !!runtime && !!agent && steps.every((s) => s.ok);
  return { ok, steps, profileId: profile.id, runtimeId: runtime.id, agentId: agent?.id ?? "" };
}

export function registerProvisionHandlers(
  server: PluginServerContext,
  settings: PluginSettings<typeof MulticaSettingsSchema>,
): void {
  server.handle(runtimeStatusRpc, async () => {
    try {
      return await computeStatus(await readRuntime(settings));
    } catch (e) {
      return {
        profileName: "",
        multicaCli: { present: false, path: "" },
        harness: { present: false, path: "" },
        binDir: { path: "", writable: false },
        wrapper: { path: "", present: false },
        profile: null,
        runtime: null,
        agent: null,
        error: e instanceof Error ? e.message : String(e),
      } satisfies RuntimeStatus;
    }
  });

  server.handle(runtimeProvisionRpc, async ({ restart, profile }) => {
    try {
      return await computeProvision(await readRuntime(settings), restart, profile);
    } catch (e) {
      return {
        ok: false,
        steps: [{ name: "执行安装", ok: false, detail: e instanceof Error ? e.message : String(e) }],
        profileId: "",
        runtimeId: "",
        agentId: "",
      } satisfies ProvisionResult;
    }
  });

  server.handle(profilesListRpc, async () => {
    try {
      return { profiles: listProfiles() };
    } catch {
      return { profiles: [] };
    }
  });

  server.handle(runtimeTeardownRpc, async () => {
    try {
      return removeWrapper(await readRuntime(settings));
    } catch (e) {
      return { removed: false, path: "", error: e instanceof Error ? e.message : String(e) };
    }
  });

  server.handle(profileCreateRpc, async ({ name, serverUrl, appUrl, workspaceId, token }) => {
    try {
      const bin = resolveBinary("multica");
      if (!bin) return { ok: false, steps: [], error: "未找到 multica CLI：请先安装 multica。" };
      return createProfile(bin, { name, serverUrl, appUrl, workspaceId, token });
    } catch (e) {
      return { ok: false, steps: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
}