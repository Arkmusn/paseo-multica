import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { MulticaSettingsSchema, type Issue, type MulticaSettingsValues } from "../shared/model";
import {
  agentCancelTaskRpc,
  agentContextRpc,
  boardProfilesRpc,
  boardSnapshotRpc,
  boardWorkspacesRpc,
  instanceTestRpc,
  instancesListRpc,
  issuesCommentRpc,
  issuesCreateRpc,
  issuesSearchRpc,
  issuesUpdateRpc,
  linksClearRpc,
  linksGetRpc,
  linksSetRpc,
  tasksCancelRpc,
  tasksSnapshotRpc,
} from "../shared/rpc";
import {
  listCliProfiles,
  pickInstance,
  resolveInstances,
  resolveProfile,
  toPublic,
  type ResolvedInstance,
} from "./config";
import { clearLink, getLink, setLink } from "./links";
import { MulticaClient, type MulticaTask } from "./multica";

const EMPTY_SETTINGS: MulticaSettingsValues = MulticaSettingsSchema.parse({});

async function readSettings(
  settings: PluginSettings<typeof MulticaSettingsSchema>,
): Promise<MulticaSettingsValues> {
  const state = await settings.read();
  return state.status === "ready" ? state.values : EMPTY_SETTINGS;
}

interface Resolved {
  values: MulticaSettingsValues;
  instances: ResolvedInstance[];
  activeId: string;
}

async function resolve(settings: PluginSettings<typeof MulticaSettingsSchema>): Promise<Resolved> {
  const values = await readSettings(settings);
  return { values, instances: resolveInstances(values), activeId: values.activeId };
}

function requireInstance(resolved: Resolved, requested?: string): ResolvedInstance {
  const inst = pickInstance(resolved.instances, resolved.activeId, requested);
  if (!inst) {
    throw new Error("尚未配置 Multica 实例：请在插件设置里添加，或先运行 multica login。");
  }
  if (!inst.token) {
    throw new Error(`实例「${inst.label}」缺少访问令牌：请在其 Multica 配置文件里完成登录，或在插件设置里填入 token。`);
  }
  return inst;
}

// 看板目标：显式 profile（+ 可选工作区）优先，其次沿用插件实例配置。
function resolveTarget(
  resolved: Resolved,
  input: { instanceId?: string; profile?: string; workspaceId?: string },
): ResolvedInstance {
  if (input.profile !== undefined) {
    const inst = resolveProfile(input.profile, input.workspaceId);
    if (!inst) {
      throw new Error(`Multica profile「${input.profile || "默认"}」未配置 server_url：请先运行 multica --profile ${input.profile || "<name>"} setup。`);
    }
    if (!inst.token) {
      throw new Error(`Multica profile「${input.profile || "默认"}」缺少令牌：请先完成 multica login。`);
    }
    return inst;
  }
  return requireInstance(resolved, input.instanceId);
}

export function registerHandlers(
  server: PluginServerContext,
  settings: PluginSettings<typeof MulticaSettingsSchema>,
): void {
  server.handle(instancesListRpc, async () => {
    const resolved = await resolve(settings);
    return {
      instances: resolved.instances.map(toPublic),
      activeId: pickInstance(resolved.instances, resolved.activeId)?.id ?? "",
    };
  });

  server.handle(instanceTestRpc, async ({ instanceId }) => {
    try {
      const resolved = await resolve(settings);
      const inst = requireInstance(resolved, instanceId);
      const client = new MulticaClient(inst);
      const [me, workspaces] = await Promise.all([client.me(), client.workspaces()]);
      const match = workspaces.find((w) => w.id === inst.workspaceId);
      return { ok: true, userEmail: me.email, workspaceName: match?.name ?? null, error: null };
    } catch (error) {
      return { ok: false, userEmail: null, workspaceName: null, error: message(error) };
    }
  });

  server.handle(boardProfilesRpc, async () => ({ profiles: listCliProfiles() }));

  server.handle(boardWorkspacesRpc, async ({ profile }) => {
    try {
      const inst = resolveProfile(profile ?? "");
      if (!inst) return { workspaces: [], error: "profile 未配置 server_url" };
      if (!inst.token) return { workspaces: [], error: "profile 缺少令牌，请先 multica login" };
      return { workspaces: await new MulticaClient(inst).workspaces(), error: null };
    } catch (error) {
      return { workspaces: [], error: message(error) };
    }
  });

  server.handle(tasksSnapshotRpc, async (input) => {
    const resolved = await resolve(settings);
    const inst = resolveTarget(resolved, input);
    const client = new MulticaClient(inst);
    try {
      const [profiles, runtimes, agents] = await Promise.all([
        client.runtimeProfiles(),
        client.runtimes(),
        client.listAgents(),
      ]);

      const commandName = resolved.values.runtime.commandName;
      const ourProfileIds = new Set(
        profiles.filter((profile) => profile.commandName === commandName && profile.enabled).map((p) => p.id),
      );
      const ourRuntimes = runtimes.filter((runtime) => runtime.profileId && ourProfileIds.has(runtime.profileId));
      const runtime = ourRuntimes.find((row) => row.status === "online") ?? ourRuntimes[0] ?? null;
      if (!runtime) {
        return {
          runtime: null,
          agents: [],
          tasks: [],
          error: "未找到本机 Paseo 运行时：请先在「运行时接入」完成接入。",
        };
      }

      const runtimeIds = new Set(ourRuntimes.map((row) => row.id));
      const ourAgents = agents.filter((agent) => agent.runtimeId && runtimeIds.has(agent.runtimeId));
      const agentIds = new Set(ourAgents.map((agent) => agent.id));

      const [rawTasks, issues] = await Promise.all([client.agentTaskSnapshot(), client.listIssues()]);
      const issueById = new Map(issues.map((issue) => [issue.id, issue]));
      const agentById = new Map(ourAgents.map((agent) => [agent.id, agent]));
      const sessions = readTaskSessions(inst.serverUrl);

      const tasks = rawTasks
        .filter((task) => agentIds.has(task.agent_id))
        .map((task) => toTaskView(task, issueById, agentById, sessions));

      return {
        runtime: {
          id: runtime.id,
          name: runtime.name,
          status: runtime.status,
          provider: runtime.provider,
          lastSeenAt: runtime.lastSeenAt,
        },
        agents: ourAgents.map((agent) => ({ id: agent.id, name: agent.name })),
        tasks,
        error: null,
      };
    } catch (error) {
      return { runtime: null, agents: [], tasks: [], error: message(error) };
    }
  });

  server.handle(agentContextRpc, async ({ agentId }) => {
    const resolved = await resolve(settings);
    const target = resolveAgentTarget(resolved, agentId);
    if (!target) {
      return {
        linked: false,
        issue: null,
        task: null,
        instance: null,
        error: "未找到该会话对应的 Multica 服务端：请先 /multica-link 关联，或让卡片由本机运行时执行。",
      };
    }

    const client = new MulticaClient(target.inst);
    try {
      const [rawTasks, workspaceSlug, link] = await Promise.all([
        client.agentTaskSnapshot(),
        client.workspaceSlug(),
        Promise.resolve(getLink(agentId)),
      ]);
      const agentTasks = rawTasks.filter((task) => task.agent_id === agentId);
      const active = agentTasks
        .filter((task) => !TERMINAL_TASK_STATUSES.has(task.status))
        .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))[0];
      const latest =
        active ??
        agentTasks.sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))[0] ??
        null;

      const issueId = link?.issueId || latest?.issue_id || "";
      const issue = issueId ? await client.getIssue(issueId).catch(() => null) : null;
      const sessions = readTaskSessions(target.inst.serverUrl);
      const issueById = new Map<string, Issue>(issue ? [[issue.id, issue]] : []);
      const agentById = new Map([[agentId, { id: agentId, name: "" }]]);

      return {
        linked: !!link,
        issue,
        task: latest ? toTaskView(latest, issueById, agentById, sessions) : null,
        instance: {
          label: target.inst.label,
          serverUrl: target.inst.serverUrl,
          appUrl: target.inst.appUrl,
          workspaceSlug,
        },
        error: null,
      };
    } catch (error) {
      return { linked: false, issue: null, task: null, instance: null, error: message(error) };
    }
  });

  server.handle(agentCancelTaskRpc, async ({ agentId, taskId }) => {
    const resolved = await resolve(settings);
    const target = resolveAgentTarget(resolved, agentId);
    if (!target) return { ok: false, error: "未找到该会话对应的 Multica 服务端" };
    try {
      await new MulticaClient(target.inst).cancelTask(taskId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  });

  server.handle(tasksCancelRpc, async (input) => {
    const resolved = await resolve(settings);
    const inst = resolveTarget(resolved, input);
    try {
      await new MulticaClient(inst).cancelTask(input.taskId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  });

  server.handle(boardSnapshotRpc, async (input) => {
    const resolved = await resolve(settings);
    const inst = resolveTarget(resolved, input);
    const client = new MulticaClient(inst);
    const [issues, agents, members, projects, statuses] = await Promise.all([
      client.listIssues(),
      client.listAgents(),
      client.listMembers(),
      client.listProjects(),
      client.statuses(),
    ]);
    return {
      instance: toPublic(inst),
      issues,
      agents,
      members,
      projects,
      statuses: statuses.statuses,
      categories: statuses.categories,
    };
  });

  server.handle(issuesCreateRpc, async (input) => {
    const resolved = await resolve(settings);
    const inst = resolveTarget(resolved, input);
    const client = new MulticaClient(inst);
    const body: Record<string, unknown> = { title: input.title };
    if (input.description) body.description = input.description;
    if (input.status) body.status = input.status;
    if (input.priority) body.priority = input.priority;
    if (input.assigneeType && input.assigneeId) {
      body.assignee_type = input.assigneeType;
      body.assignee_id = input.assigneeId;
    }
    if (input.projectId) body.project_id = input.projectId;
    return { issue: await client.createIssue(body) };
  });

  server.handle(issuesUpdateRpc, async (input) => {
    const resolved = await resolve(settings);
    const inst = resolveTarget(resolved, input);
    const client = new MulticaClient(inst);
    const body: Record<string, unknown> = {};
    if (input.status !== undefined) body.status = input.status;
    if (input.priority !== undefined) body.priority = input.priority;
    if (input.assigneeType !== undefined) body.assignee_type = input.assigneeType;
    if (input.assigneeId !== undefined) body.assignee_id = input.assigneeId;
    return { issue: await client.updateIssue(input.issueId, body) };
  });

  server.handle(issuesCommentRpc, async (input) => {
    const resolved = await resolve(settings);
    const inst = requireInstance(resolved, input.instanceId);
    const client = new MulticaClient(inst);
    await client.comment(input.issueId, input.content);
    return { ok: true };
  });

  server.handle(issuesSearchRpc, async ({ instanceId, query }) => {
    const resolved = await resolve(settings);
    const inst = pickInstance(resolved.instances, resolved.activeId, instanceId);
    if (!inst) return { items: [] };
    const client = new MulticaClient(inst);
    const issues = query.trim() ? await client.searchIssues(query.trim()) : await client.listIssues();
    const items = issues.map((issue) => {
      const subtitleParts = [issue.status];
      if (issue.priority && issue.priority !== "none") subtitleParts.push(issue.priority);
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        subtitle: subtitleParts.join(" · "),
        url: client.issueUrl(issue.identifier) || inst.serverUrl,
        text: issueSnapshot(issue.identifier, issue.title, issue.description, issue.status, issue.priority),
        resourceType: "multica-issue",
      };
    });
    return { items };
  });

  server.handle(linksSetRpc, async ({ agentId, issueRef, instanceId }) => {
    const resolved = await resolve(settings);
    const inst = requireInstance(resolved, instanceId);
    // issueRef 可以是 UUID 或裸标识（如 PUCK-5），服务端会解析为规范 UUID。
    const issue = await new MulticaClient(inst).getIssue(issueRef);
    setLink(agentId, {
      instanceId: inst.id,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    });
    return { ok: true, issueIdentifier: issue.identifier };
  });

  server.handle(linksClearRpc, async ({ agentId }) => {
    clearLink(agentId);
    return { ok: true };
  });

  server.handle(linksGetRpc, async ({ agentId }) => {
    return { link: getLink(agentId) };
  });

}

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

function toTaskView(
  task: MulticaTask,
  issueById: Map<string, Issue>,
  agentById: Map<string, { id: string; name: string }>,
  sessions: Map<string, { agentId: string; paseoWorkspaceId: string }>,
) {
  const issue = issueById.get(task.issue_id ?? "");
  const session = sessions.get(task.id);
  return {
    id: task.id,
    agentId: task.agent_id,
    agentName: agentById.get(task.agent_id)?.name ?? "",
    issueId: task.issue_id ?? "",
    issueIdentifier: issue?.identifier ?? "",
    issueTitle: issue?.title ?? "",
    workspaceSlug: task.workspace_slug ?? "",
    status: task.status,
    triggerSummary: task.trigger_summary ?? null,
    dispatchedAt: task.dispatched_at ?? null,
    startedAt: task.started_at ?? null,
    completedAt: task.completed_at ?? null,
    createdAt: task.created_at ?? "",
    sessionId: session?.agentId ?? null,
    paseoWorkspaceId: session?.paseoWorkspaceId ?? "",
    error: task.error ?? null,
  };
}

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

// 读取某个 Paseo agent 最近一次任务映射（harness 写入）。
function readAgentSession(agentId: string): {
  taskId: string;
  paseoWorkspaceId: string;
  serverUrl: string;
  multicaWorkspaceId: string;
} | null {
  const path = join(homedir(), ".paseo", "plugin-data", "paseo-multica", "task-sessions.jsonl");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let found: {
    taskId: string;
    paseoWorkspaceId: string;
    serverUrl: string;
    multicaWorkspaceId: string;
    at: string;
  } | null = null;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        taskId?: string;
        agentId?: string;
        paseoWorkspaceId?: string;
        serverUrl?: string;
        multicaWorkspaceId?: string;
        at?: string;
      };
      if (row.agentId !== agentId || !row.taskId) continue;
      if (!found || (row.at ?? "") > found.at) {
        found = {
          taskId: row.taskId,
          paseoWorkspaceId: row.paseoWorkspaceId ?? "",
          serverUrl: row.serverUrl ?? "",
          multicaWorkspaceId: row.multicaWorkspaceId ?? "",
          at: row.at ?? "",
        };
      }
    } catch {
      // 跳过损坏行。
    }
  }
  return found;
}

// 一个 Paseo 会话属于哪个 Multica 服务端：优先显式关联的实例，其次 harness 记录的服务端。
function resolveAgentTarget(
  resolved: Resolved,
  agentId: string,
): { inst: ResolvedInstance; linked: boolean } | null {
  const link = getLink(agentId);
  if (link) {
    // 看板/旧版起会话写入的是 profile 目标（profile:<name>），不是设置里的实例 id。
    if (link.instanceId.startsWith("profile:")) {
      const name = link.instanceId.slice("profile:".length);
      const inst = resolveProfile(name === "default" ? "" : name);
      if (inst?.token) return { inst, linked: true };
    }
    const inst = pickInstance(resolved.instances, resolved.activeId, link.instanceId);
    if (inst?.token) return { inst, linked: true };
  }

  const session = readAgentSession(agentId);
  if (session?.serverUrl) {
    const profile = listCliProfiles().find(
      (item) => normalizeServerUrl(item.serverUrl) === normalizeServerUrl(session.serverUrl),
    );
    if (profile) {
      const inst = resolveProfile(profile.name, session.multicaWorkspaceId || profile.workspaceId);
      if (inst?.token) return { inst, linked: false };
    }
  }

  try {
    return { inst: requireInstance(resolved), linked: false };
  } catch {
    return null;
  }
}

// harness 追加写入的「Multica 任务 -> Paseo 会话」映射（最新一条生效）。
function readTaskSessions(
  serverUrl: string,
): Map<string, { agentId: string; paseoWorkspaceId: string }> {
  const out = new Map<string, { agentId: string; paseoWorkspaceId: string }>();
  const path = join(homedir(), ".paseo", "plugin-data", "paseo-multica", "task-sessions.jsonl");
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return out;
  }

  const expected = serverUrl.replace(/\/+$/, "");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        taskId?: string;
        agentId?: string;
        paseoWorkspaceId?: string;
        serverUrl?: string;
      };
      if (!row.taskId || !row.agentId) continue;
      if (row.serverUrl && row.serverUrl.replace(/\/+$/, "") !== expected) continue;
      out.set(row.taskId, {
        agentId: row.agentId,
        paseoWorkspaceId: row.paseoWorkspaceId ?? "",
      });
    } catch {
      // 跳过损坏行。
    }
  }
  return out;
}

function issueSnapshot(
  identifier: string,
  title: string,
  description: string | null,
  status: string,
  priority: string,
): string {
  const parts = [`Multica 卡片 ${identifier}: ${title}`];
  if (description && description.trim()) parts.push("", description.trim());
  parts.push("", `状态: ${status}`, `优先级: ${priority}`);
  return parts.join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}