import type { AgentRef, Issue, ProjectRef, StatusRef } from "../shared/model";
import type { ResolvedInstance } from "./config";

// workspaceId -> slug 的内存缓存，避免每次请求都查一次 /api/workspaces。
const slugCache = new Map<string, string>();

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  status: string;
  status_category?: string | null;
  status_name?: string | null;
  priority?: string | null;
  assignee_type?: string | null;
  assignee_id?: string | null;
  project_id?: string | null;
  position?: number | null;
  start_date?: string | null;
  due_date?: string | null;
  labels?: Array<{ id?: string; name?: string; color?: string | null }> | null;
  updated_at?: string | null;
  created_at?: string | null;
}

interface RawMember {
  user_id: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

interface RawAgent {
  id: string;
  name: string;
  avatar_url?: string | null;
  status?: string | null;
}

interface RawProject {
  id: string;
  title: string;
}

interface RawStatus {
  key: string;
  name: string;
  category: string;
  color?: string | null;
  position?: number | null;
  is_system?: boolean | null;
}

export function normalizeIssue(raw: RawIssue): Issue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? null,
    status: raw.status,
    statusCategory: raw.status_category ?? raw.status,
    statusName: raw.status_name ?? "",
    priority: raw.priority ?? "none",
    assigneeType: raw.assignee_type ?? null,
    assigneeId: raw.assignee_id ?? null,
    projectId: raw.project_id ?? null,
    position: typeof raw.position === "number" ? raw.position : 0,
    startDate: raw.start_date ?? null,
    dueDate: raw.due_date ?? null,
    labels: (raw.labels ?? [])
      .filter((label): label is { id: string; name: string; color?: string | null } => !!label?.id && !!label?.name)
      .map((label) => ({ id: label.id, name: label.name, color: label.color ?? "#6b7280" })),
    updatedAt: raw.updated_at ?? "",
    createdAt: raw.created_at ?? "",
  };
}

export class MulticaClient {
  private readonly inst: ResolvedInstance;

  constructor(inst: ResolvedInstance) {
    this.inst = inst;
  }

  private base(): string {
    return this.inst.serverUrl.replace(/\/+$/, "");
  }

  // workspace 上下文：优先用 slug（与 web 端一致），否则回退到 workspace id。
  private async ensureSlug(): Promise<string> {
    if (this.inst.workspaceSlug) return this.inst.workspaceSlug;
    if (!this.inst.workspaceId) return "";
    const key = `${this.base()}|${this.inst.workspaceId}`;
    const cached = slugCache.get(key);
    if (cached) return cached;

    const res = await fetch(`${this.base()}/api/workspaces`, {
      headers: { Authorization: `Bearer ${this.inst.token}` },
    });
    if (!res.ok) return "";
    const list = (await res.json()) as Array<{ id: string; slug?: string }>;
    const match = list.find((w) => w.id === this.inst.workspaceId);
    if (match?.slug) {
      slugCache.set(key, match.slug);
      // 回写到实例，使随后的 issueUrl 能拼出带 slug 的网页链接。
      this.inst.workspaceSlug = match.slug;
      return match.slug;
    }
    return "";
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.inst.token}`,
      "Content-Type": "application/json",
    };
    const slug = await this.ensureSlug();
    if (slug) {
      headers["X-Workspace-Slug"] = slug;
    } else if (this.inst.workspaceId) {
      headers["X-Workspace-ID"] = this.inst.workspaceId;
    }

    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        detail = "";
      }
      throw new Error(`Multica ${method} ${path} -> ${res.status} ${detail.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return undefined as T;
    return (await res.json()) as T;
  }

  async me(): Promise<{ id: string; email: string }> {
    return this.send("GET", "/api/me");
  }

  async workspaces(): Promise<Array<{ id: string; name: string; slug: string }>> {
    return this.send("GET", "/api/workspaces");
  }

  async listIssues(statuses?: string[]): Promise<Issue[]> {
    const params: string[] = [];
    if (this.inst.workspaceId) params.push(`workspace_id=${encodeURIComponent(this.inst.workspaceId)}`);
    if (statuses?.length) params.push(`statuses=${encodeURIComponent(statuses.join(","))}`);
    const qs = params.join("&");
    const raw = await this.send<{ issues?: RawIssue[] }>("GET", `/api/issues${qs ? `?${qs}` : ""}`);
    return (raw.issues ?? []).map(normalizeIssue);
  }

  async getIssue(issueId: string): Promise<Issue> {
    const raw = await this.send<RawIssue>("GET", `/api/issues/${encodeURIComponent(issueId)}`);
    return normalizeIssue(raw);
  }

  async createIssue(data: Record<string, unknown>): Promise<Issue> {
    const raw = await this.send<RawIssue>("POST", "/api/issues", data);
    return normalizeIssue(raw);
  }

  async updateIssue(issueId: string, data: Record<string, unknown>): Promise<Issue> {
    const raw = await this.send<RawIssue>("PUT", `/api/issues/${encodeURIComponent(issueId)}`, data);
    return normalizeIssue(raw);
  }

  async comment(issueId: string, content: string): Promise<void> {
    await this.send("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, {
      content,
      type: "comment",
    });
  }

  async listMembers(): Promise<Array<{ id: string; name: string; email: string; avatarUrl: string | null }>> {
    if (!this.inst.workspaceId) return [];
    const raw = await this.send<RawMember[]>(
      "GET",
      `/api/workspaces/${encodeURIComponent(this.inst.workspaceId)}/members`,
    );
    return (raw ?? []).map((member) => ({
      id: member.user_id,
      name: member.name ?? "",
      email: member.email ?? "",
      avatarUrl: member.avatar_url ?? null,
    }));
  }

  async listAgents(): Promise<AgentRef[]> {
    const params = this.inst.workspaceId ? `?workspace_id=${encodeURIComponent(this.inst.workspaceId)}` : "";
    const raw = await this.send<RawAgent[]>("GET", `/api/agents${params}`);
    return (raw ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      avatarUrl: a.avatar_url ?? null,
      status: a.status ?? "idle",
    }));
  }

  async listProjects(): Promise<ProjectRef[]> {
    const params = this.inst.workspaceId ? `?workspace_id=${encodeURIComponent(this.inst.workspaceId)}` : "";
    const raw = await this.send<{ projects?: RawProject[] } | RawProject[]>("GET", `/api/projects${params}`);
    const list = Array.isArray(raw) ? raw : (raw.projects ?? []);
    return list.map((p) => ({ id: p.id, title: p.title }));
  }

  async statuses(): Promise<{ categories: string[]; statuses: StatusRef[] }> {
    const raw = await this.send<{ categories?: string[]; statuses?: RawStatus[] }>(
      "GET",
      "/api/issue-statuses",
    );
    return {
      categories: raw.categories ?? [],
      statuses: (raw.statuses ?? []).map((s) => ({
        key: s.key,
        name: s.name,
        category: s.category,
        color: s.color ?? "#6b7280",
        position: typeof s.position === "number" ? s.position : 0,
        isSystem: s.is_system ?? false,
      })),
    };
  }

  async searchIssues(query: string, limit = 20): Promise<Issue[]> {
    const qs = `q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`;
    const raw = await this.send<{ issues?: RawIssue[] }>("GET", `/api/issues/search?${qs}`);
    return (raw.issues ?? []).map(normalizeIssue);
  }

  // 网页端 issue 详情链接。
  issueUrl(identifier: string): string {
    if (!this.inst.appUrl) return "";
    const base = this.inst.appUrl.replace(/\/+$/, "");
    const slug = this.inst.workspaceSlug;
    return slug ? `${base}/${slug}/issues/${identifier}` : `${base}/issues/${identifier}`;
  }
}