import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// 一个 Multica 实例的连接配置。token 留空时从 configPath 指向的 Multica CLI 配置文件读取；
// 显式填写 token 会覆盖文件。configPath 默认指向本机 Multica CLI 的配置。
export const InstanceSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  serverUrl: z.string().default("http://localhost:8080"),
  appUrl: z.string().default(""),
  workspaceId: z.string().default(""),
  workspaceSlug: z.string().default(""),
  configPath: z.string().default("~/.multica/config.json"),
  token: z.string().default(""),
  writeBack: z.boolean().default(false),
});

// 「运行时接入」配置：把这台机器上的 Paseo 作为一个自定义 Multica 运行时接进去。
// 安装器会依据这些值落一个 wrapper 到 PATH，并幂等地注册 profile/agent。
export const RuntimeSettingsSchema = z.object({
  // Multica CLI profile（空=默认 profile）。用于在同一台机器上接入多个 Multica daemon。
  profile: z.string().default(""),
  binDir: z.string().default(""),
  harnessPath: z.string().default(""),
  runtimeType: z.string().default("dim"),
  commandName: z.string().default("paseo-acp-harness"),
  displayName: z.string().default("Paseo ACP (dim)"),
  provider: z.string().default("codex/gpt-5.6-sol"),
  agentName: z.string().default("Paseo Runner"),
  restartDaemon: z.boolean().default(true),
});

export const MulticaSettingsSchema = z.object({
  instances: z.array(InstanceSchema).default([]),
  activeId: z.string().default(""),
  runtime: RuntimeSettingsSchema.default({
    profile: "",
    binDir: "",
    harnessPath: "",
    runtimeType: "dim",
    commandName: "paseo-acp-harness",
    displayName: "Paseo ACP (dim)",
    provider: "codex/gpt-5.6-sol",
    agentName: "Paseo Runner",
    restartDaemon: true,
  }),
});

export const multicaSettings = defineSettings({
  id: "instances",
  scope: "host",
  version: 1,
  schema: MulticaSettingsSchema,
});

export type MulticaInstanceConfig = z.infer<typeof InstanceSchema>;
export type MulticaSettingsValues = z.infer<typeof MulticaSettingsSchema>;
export type RuntimeSettingsValues = z.infer<typeof RuntimeSettingsSchema>;

// 暴露给界面的实例视图：永不含 token，只带 hasToken 标记。
export const PublicInstanceSchema = z.object({
  id: z.string(),
  label: z.string(),
  serverUrl: z.string(),
  appUrl: z.string(),
  workspaceId: z.string(),
  workspaceSlug: z.string(),
  writeBack: z.boolean(),
  hasToken: z.boolean(),
  isDefault: z.boolean(),
});

export const LabelRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});

export const MemberRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
});

export const IssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  statusCategory: z.string(),
  statusName: z.string(),
  priority: z.string(),
  assigneeType: z.string().nullable(),
  assigneeId: z.string().nullable(),
  projectId: z.string().nullable(),
  position: z.number(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  labels: z.array(LabelRefSchema),
  updatedAt: z.string(),
  createdAt: z.string(),
});

export const AgentRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  status: z.string(),
});

export const ProjectRefSchema = z.object({
  id: z.string(),
  title: z.string(),
});

export const StatusRefSchema = z.object({
  key: z.string(),
  name: z.string(),
  category: z.string(),
  color: z.string(),
  position: z.number(),
  isSystem: z.boolean(),
});

export const BoardSchema = z.object({
  instance: PublicInstanceSchema,
  issues: z.array(IssueSchema),
  agents: z.array(AgentRefSchema),
  members: z.array(MemberRefSchema),
  projects: z.array(ProjectRefSchema),
  statuses: z.array(StatusRefSchema),
  categories: z.array(z.string()),
});

export const AttachmentItemSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  url: z.string(),
  text: z.string(),
  resourceType: z.string(),
});

export type PublicInstance = z.infer<typeof PublicInstanceSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type AgentRef = z.infer<typeof AgentRefSchema>;
export type ProjectRef = z.infer<typeof ProjectRefSchema>;
export type StatusRef = z.infer<typeof StatusRefSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type AttachmentItem = z.infer<typeof AttachmentItemSchema>;