import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 「运行时接入」：把本机 Paseo 作为自定义 Multica 运行时接进去。
// 安装器做的事（全部幂等）：
//   1. 在本机 PATH 目录落一个 paseo-acp-harness wrapper（指向 harness 可执行）
//   2. 注册自定义 runtime profile（协议族 ACP，如 hermes）
//   3. 重启 Multica daemon 让 profile 生效
//   4. 建/复用绑定该 runtime 的 agent

export const ProvisionStepSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

export const runtimeStatusRpc = defineRpc({
  name: "runtime.status",
  input: z.object({ instanceId: z.string().optional() }),
  output: z.object({
    profileName: z.string(),
    multicaCli: z.object({ present: z.boolean(), path: z.string() }),
    harness: z.object({ present: z.boolean(), path: z.string() }),
    binDir: z.object({ path: z.string(), writable: z.boolean() }),
    wrapper: z.object({ path: z.string(), present: z.boolean() }),
    profile: z
      .object({
        id: z.string(),
        commandName: z.string(),
        protocolFamily: z.string(),
        displayName: z.string(),
      })
      .nullable(),
    runtime: z
      .object({ id: z.string(), launchHeader: z.string(), status: z.string() })
      .nullable(),
    agent: z.object({ id: z.string(), name: z.string() }).nullable(),
    error: z.string().nullable(),
  }),
});

export const runtimeProvisionRpc = defineRpc({
  name: "runtime.provision",
  input: z.object({
    instanceId: z.string().optional(),
    // 一次性覆盖设置里的 profile；为空则用设置里的（空=默认 profile）。
    profile: z.string().optional(),
    restart: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    steps: z.array(ProvisionStepSchema),
    profileId: z.string(),
    runtimeId: z.string(),
    agentId: z.string(),
  }),
});

// 本机 Multica CLI profile（默认 profile 名称为空串）。
export const ProfileSchema = z.object({
  name: z.string(),
  serverUrl: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  isDefault: z.boolean(),
});

export const profilesListRpc = defineRpc({
  name: "runtime.profiles",
  input: z.object({}),
  output: z.object({ profiles: z.array(ProfileSchema) }),
});

export const profileCreateRpc = defineRpc({
  name: "runtime.create-profile",
  input: z.object({
    name: z.string().min(1),
    serverUrl: z.string().min(1),
    appUrl: z.string().optional(),
    workspaceId: z.string().optional(),
    token: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    steps: z.array(ProvisionStepSchema),
    error: z.string(),
  }),
});

// 移除本机接入：删除 PATH 里的 wrapper（不动 Multica 侧的 runtime/agent）。
export const runtimeTeardownRpc = defineRpc({
  name: "runtime.teardown",
  input: z.object({ instanceId: z.string().optional() }),
  output: z.object({
    removed: z.boolean(),
    path: z.string(),
    error: z.string(),
  }),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusRpc.output>;
export type ProvisionStep = z.infer<typeof ProvisionStepSchema>;
export type ProvisionResult = z.infer<typeof runtimeProvisionRpc.output>;