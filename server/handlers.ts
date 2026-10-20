import { homedir } from "node:os";
import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { MulticaSettingsSchema, type MulticaSettingsValues } from "../shared/model";
import {
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
import { MulticaClient } from "./multica";

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