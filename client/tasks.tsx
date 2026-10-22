import { openExternalUrl, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  boardProfilesRpc,
  boardWorkspacesRpc,
  tasksCancelRpc,
  tasksSnapshotRpc,
} from "../shared/rpc";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const STATUS_META: Record<string, { label: string; color: string }> = {
  queued: { label: "排队", color: "#f59e0b" },
  dispatched: { label: "已派发", color: "#3b82f6" },
  running: { label: "运行中", color: "#10b981" },
  waiting_local_directory: { label: "等待目录", color: "#8b5cf6" },
  completed: { label: "完成", color: "#10b981" },
  failed: { label: "失败", color: "#ef4444" },
  cancelled: { label: "已取消", color: "#9ca3af" },
};

function statusMeta(status: string): { label: string; color: string } {
  return STATUS_META[status] ?? { label: status, color: "#9ca3af" };
}

function formatDuration(start: string | null, end: string | null): string {
  const from = start ? Date.parse(start) : Number.NaN;
  if (!Number.isFinite(from)) return "";
  const to = end ? Date.parse(end) : Date.now();
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分`;
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
  }
  return `${Math.floor(seconds / 86_400)} 天`;
}

function taskTime(task: { startedAt: string | null; dispatchedAt: string | null; createdAt: string }): number {
  const value = Date.parse(task.startedAt ?? task.dispatchedAt ?? task.createdAt);
  return Number.isFinite(value) ? value : 0;
}

// 本机 Paseo 运行时上由 Multica 派发的任务；5 秒轮询刷新。
export function MulticaTasksScreen({ theme, layout, navigation }: PluginScreenProps) {
  const profilesRpc = useRpc(boardProfilesRpc);
  const workspacesRpc = useRpc(boardWorkspacesRpc);
  const snapshotRpc = useRpc(tasksSnapshotRpc);
  const cancelRpc = useRpc(tasksCancelRpc);

  const [profile, setProfile] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const padding = layout.compact ? 12 : 20;

  const profilesQuery = useQuery({ queryKey: ["multica-profiles"], queryFn: () => profilesRpc({}) });
  const workspacesQuery = useQuery({
    queryKey: ["multica-workspaces", profile],
    queryFn: () => workspacesRpc({ profile }),
  });

  const profiles = profilesQuery.data?.profiles ?? [];
  const workspaces = workspacesQuery.data?.workspaces ?? [];

  useEffect(() => {
    if (profiles.length === 0) return;
    if (profiles.some((item) => item.name === profile)) return;
    setProfile(profiles[0]!.name);
  }, [profiles, profile]);

  useEffect(() => {
    setWorkspaceId("");
  }, [profile]);

  useEffect(() => {
    if (workspaceId || workspaces.length === 0) return;
    const preferred = profiles.find((item) => item.name === profile)?.workspaceId;
    setWorkspaceId(workspaces.some((item) => item.id === preferred) ? preferred! : workspaces[0]!.id);
  }, [workspaceId, workspaces, profiles, profile]);

  const snapshot = useQuery({
    queryKey: ["multica-tasks", profile, workspaceId],
    queryFn: () => snapshotRpc({ profile, workspaceId }),
    enabled: !!workspaceId,
    refetchInterval: 5000,
  });

  const cancel = useMutation({
    mutationFn: (taskId: string) => cancelRpc({ profile, workspaceId, taskId }),
    onSuccess: (result) => {
      setNotice(result.ok ? "已请求取消" : result.error ?? "取消失败");
      if (result.ok) void snapshot.refetch();
    },
    onError: (error) => setNotice(errorText(error)),
  });

  const activeProfile = profiles.find((item) => item.name === profile);
  const activeWorkspace = workspaces.find((item) => item.id === workspaceId);
  const appUrl = activeProfile?.appUrl?.replace(/\/+$/, "") ?? "";

  const tasks = snapshot.data?.tasks ?? [];
  const activeTasks = useMemo(
    () => tasks.filter((task) => !TERMINAL.has(task.status)).sort((a, b) => taskTime(b) - taskTime(a)),
    [tasks],
  );
  const recentTasks = useMemo(
    () =>
      tasks
        .filter((task) => TERMINAL.has(task.status))
        .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt))
        .slice(0, 12),
    [tasks],
  );

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: padding,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        flexWrap: "wrap" as const,
      },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      small: { color: theme.colors.foregroundMuted, fontSize: 11 },
      groupLabel: { color: theme.colors.foregroundMuted, fontSize: 11 },
      groupDivider: { width: 1, height: 16, backgroundColor: theme.colors.border, marginHorizontal: 2 },
      chip: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      chipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 12 },
      chipTextActive: { color: theme.colors.accentForeground, fontSize: 12 },
      info: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        paddingHorizontal: padding,
        paddingVertical: 6,
      },
      notice: { color: theme.colors.foreground, fontSize: 12, paddingHorizontal: padding, paddingBottom: 6 },
      list: { flex: 1 },
      listContent: { paddingHorizontal: padding, paddingBottom: 24, gap: 8 },
      section: { color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 12, marginBottom: 2 },
      row: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: 10,
        borderLeftWidth: 3,
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        alignItems: layout.compact ? ("stretch" as const) : ("flex-start" as const),
        gap: 8,
      },
      rowBody: { flex: 1, gap: 3, minWidth: 0 },
      rowTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      statusDot: { width: 7, height: 7, borderRadius: 4 },
      statusText: { fontSize: 11, fontWeight: "600" as const },
      issue: { color: theme.colors.foregroundMuted, fontSize: 11 },
      issueTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "500" as const },
      trigger: { color: theme.colors.foregroundMuted, fontSize: 11 },
      actions: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
      action: {
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.surface0,
      },
      actionDanger: { backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: "#ef4444" },
      actionText: { color: theme.colors.foreground, fontSize: 11 },
      actionDangerText: { color: "#ef4444", fontSize: 11 },
      center: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, gap: 8 },
    }),
    [theme, padding, layout.compact],
  );

  if (profilesQuery.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const runtime = snapshot.data?.runtime ?? null;
  const error = snapshot.data?.error ?? (snapshot.isError ? errorText(snapshot.error) : null);
  const runtimeColor = runtime?.status === "online" ? "#10b981" : "#9ca3af";

  const renderTask = (task: (typeof tasks)[number]) => {
    const meta = statusMeta(task.status);
    const slug = task.workspaceSlug || activeWorkspace?.slug || "";
    const issueUrl =
      appUrl && slug && task.issueIdentifier
        ? `${appUrl}/${slug}/issues/${task.issueIdentifier}`
        : "";
    const duration = formatDuration(task.startedAt ?? task.dispatchedAt, task.completedAt);
    const active = !TERMINAL.has(task.status);

    return (
      <View key={task.id} style={[styles.row, { borderLeftColor: meta.color }]}>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <View style={[styles.statusDot, { backgroundColor: meta.color }]} />
            <Text style={[styles.statusText, { color: meta.color }]}>{meta.label}</Text>
            <Text style={styles.issue}>
              {task.issueIdentifier || task.issueId.slice(0, 8)}
              {task.agentName ? ` · ${task.agentName}` : ""}
            </Text>
          </View>
          <Text style={styles.issueTitle} numberOfLines={2}>
            {task.issueTitle || task.triggerSummary || "（无标题）"}
          </Text>
          {task.triggerSummary && task.issueTitle ? (
            <Text style={styles.trigger} numberOfLines={1}>
              {task.triggerSummary}
            </Text>
          ) : null}
          <Text style={styles.small}>
            {duration ? `${active ? "已运行" : "耗时"} ${duration}` : ""}
            {task.error ? ` · ${task.error}` : ""}
          </Text>
        </View>
        <View style={styles.actions}>
          {issueUrl ? (
            <Pressable
              accessibilityRole="button"
              style={styles.action}
              onPress={() => void openExternalUrl(issueUrl)}
            >
              <Text style={styles.actionText}>网页</Text>
            </Pressable>
          ) : null}
          {task.sessionId && navigation?.openAgent ? (
            <Pressable
              accessibilityRole="button"
              style={styles.action}
              onPress={() => navigation.openAgent?.({ agentId: task.sessionId! })}
            >
              <Text style={styles.actionText}>会话</Text>
            </Pressable>
          ) : null}
          {active ? (
            <Pressable
              accessibilityRole="button"
              disabled={cancel.isPending}
              style={[styles.action, styles.actionDanger]}
              onPress={() => cancel.mutate(task.id)}
            >
              <Text style={styles.actionDangerText}>取消</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Text style={styles.title}>本机任务</Text>
        {runtime ? (
          <View style={styles.chip}>
            <Text style={[styles.chipText, { color: runtimeColor }]}>
              {runtime.name} · {runtime.status}
            </Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" style={styles.chip} onPress={() => void snapshot.refetch()}>
          <Text style={styles.chipText}>刷新</Text>
        </Pressable>
      </View>

      <View style={styles.bar}>
        <Text style={styles.groupLabel}>Profile</Text>
        {profiles.map((item) => (
          <Pressable
            key={item.name || "default"}
            accessibilityRole="button"
            onPress={() => setProfile(item.name)}
            style={[styles.chip, item.name === profile ? styles.chipActive : null]}
          >
            <Text style={item.name === profile ? styles.chipTextActive : styles.chipText}>
              {item.label}
            </Text>
          </Pressable>
        ))}
        <View style={styles.groupDivider} />
        <Text style={styles.groupLabel}>工作区</Text>
        {workspaces.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            onPress={() => setWorkspaceId(item.id)}
            style={[styles.chip, item.id === workspaceId ? styles.chipActive : null]}
          >
            <Text style={item.id === workspaceId ? styles.chipTextActive : styles.chipText}>
              {item.name || item.slug || item.id}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.info}>
        {activeProfile ? `Profile ${activeProfile.label}` : ""}
        {activeWorkspace ? ` · 工作区 ${activeWorkspace.name}` : ""}
        {snapshot.data ? ` · ${snapshot.data.agents.length} 个 agent` : ""}
        {` · 进行中 ${activeTasks.length}`}
      </Text>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      {!workspaceId ? (
        <View style={styles.center}>
          <Text style={styles.muted}>请选择工作区</Text>
        </View>
      ) : snapshot.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.muted}>{error}</Text>
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          <Text style={styles.section}>进行中</Text>
          {activeTasks.length === 0 ? (
            <Text style={styles.muted}>本机暂无进行中的任务</Text>
          ) : (
            activeTasks.map(renderTask)
          )}

          {recentTasks.length > 0 ? <Text style={styles.section}>最近完成</Text> : null}
          {recentTasks.map(renderTask)}
        </ScrollView>
      )}
    </View>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}