import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  AgentRefSchema,
  BoardSchema,
  IssueSchema,
  ProjectRefSchema,
  PublicInstanceSchema,
  StatusRefSchema,
} from "./model";

const instanceId = z.string().optional();
const profile = z.string().optional();
const workspaceId = z.string().optional();

export const instancesListRpc = defineRpc({
  name: "instances.list",
  input: z.object({}),
  output: z.object({
    instances: z.array(PublicInstanceSchema),
    activeId: z.string(),
  }),
});

export const instanceTestRpc = defineRpc({
  name: "instance.test",
  input: z.object({ instanceId }),
  output: z.object({
    ok: z.boolean(),
    userEmail: z.string().nullable(),
    workspaceName: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const boardSnapshotRpc = defineRpc({
  name: "board.snapshot",
  input: z.object({ instanceId, profile, workspaceId }),
  output: BoardSchema,
});

// 本机 Multica CLI profile 列表（看板用于切换服务端）。
export const boardProfilesRpc = defineRpc({
  name: "board.profiles",
  input: z.object({}),
  output: z.object({
    profiles: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        serverUrl: z.string(),
        appUrl: z.string(),
        workspaceId: z.string(),
      }),
    ),
  }),
});

// 指定 profile 下可用的工作区。
export const boardWorkspacesRpc = defineRpc({
  name: "board.workspaces",
  input: z.object({ profile }),
  output: z.object({
    workspaces: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
    error: z.string().nullable(),
  }),
});

export const issuesCreateRpc = defineRpc({
  name: "issues.create",
  input: z.object({
    instanceId,
    profile,
    workspaceId,
    title: z.string().min(1),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    assigneeType: z.string().optional(),
    assigneeId: z.string().optional(),
    projectId: z.string().optional(),
  }),
  output: z.object({ issue: IssueSchema }),
});

export const issuesUpdateRpc = defineRpc({
  name: "issues.update",
  input: z.object({
    instanceId,
    profile,
    workspaceId,
    issueId: z.string().min(1),
    status: z.string().optional(),
    priority: z.string().optional(),
    assigneeType: z.string().nullable().optional(),
    assigneeId: z.string().nullable().optional(),
  }),
  output: z.object({ issue: IssueSchema }),
});

export const issuesCommentRpc = defineRpc({
  name: "issues.comment",
  input: z.object({
    instanceId,
    issueId: z.string().min(1),
    content: z.string().min(1),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const issuesSearchRpc = defineRpc({
  name: "issues.search",
  input: z.object({ instanceId, query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

export const linksSetRpc = defineRpc({
  name: "links.set",
  input: z.object({
    agentId: z.string().min(1),
    issueRef: z.string().min(1),
    instanceId,
  }),
  output: z.object({ ok: z.boolean(), issueIdentifier: z.string() }),
});

export const linksClearRpc = defineRpc({
  name: "links.clear",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export const linksGetRpc = defineRpc({
  name: "links.get",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    link: z
      .object({
        instanceId: z.string(),
        issueId: z.string(),
        issueIdentifier: z.string(),
      })
      .nullable(),
  }),
});

export type InstancesListOutput = z.infer<typeof instancesListRpc.output>;
export type BoardSnapshotInput = z.infer<typeof boardSnapshotRpc.input>;
export type IssueRef = z.infer<typeof AgentRefSchema>;
export type ProjectRefOut = z.infer<typeof ProjectRefSchema>;
export type StatusRefOut = z.infer<typeof StatusRefSchema>;