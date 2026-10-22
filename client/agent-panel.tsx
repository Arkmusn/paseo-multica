import {
  openExternalUrl,
  useRpc,
  type PluginAgentPanelProps,
} from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { agentCancelTaskRpc, agentContextRpc, linksClearRpc } from "../shared/rpc";

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

const PRIORITY_META: Record<string, { label: string; color: string }> = {
  urgent: { label: "紧急", color: "#dc2626" },
  high: { label: "高", color: "#ef4444" },
  medium: { label: "中", color: "#f59e0b" },
  low: { label: "低", color: "#3b82f6" },
  none: { label: "无优先级", color: "#6b7280" },
};

function statusMeta(status: string): { label: string; color: string } {
  return STATUS_META[status] ?? { label: status, color: "#9ca3af" };
}

function previewMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-+>]\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

function relativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  return `${Math.floor(diff / day)} 天前`;
}

export function MulticaAgentPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const queryClient = useQueryClient();
  const contextRpc = useRpc(agentContextRpc);
  const cancelRpc = useRpc(agentCancelTaskRpc);
  const clearLink = useRpc(linksClearRpc);

  const padding = layout.compact ? 14 : 20;

  const query = useQuery({
    queryKey: ["multica-agent", agentId],
    queryFn: () => contextRpc({ agentId }),
    refetchInterval: 10_000,
  });

  const unlink = useMutation({
    mutationFn: () => clearLink({ agentId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["multica-agent", agentId] }),
  });

  const cancel = useMutation({
    mutationFn: (taskId: string) => cancelRpc({ agentId, taskId }),
    onSuccess: () => void query.refetch(),
  });

  const data = query.data;
  const issue = data?.issue ?? null;
  const task = data?.task ?? null;
  const instance = data?.instance ?? null;

  const issueUrl = useMemo(() => {
    if (!issue || !instance?.appUrl || !instance.workspaceSlug) return "";
    const base = instance.appUrl.replace(/\/+$/, "");
    return `${base}/${instance.workspaceSlug}/issues/${issue.identifier}`;
  }, [issue, instance]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0, padding, gap: 12 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: 12,
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      id: { color: theme.colors.foregroundMuted, fontSize: 12 },
      issueTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      desc: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      section: { color: theme.colors.foregroundMuted, fontSize: 11 },
      chip: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      chipText: { color: theme.colors.foreground, fontSize: 11 },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const, marginTop: 4 },
      action: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
      },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      danger: { borderWidth: 1, borderColor: "#ef4444", backgroundColor: theme.colors.surface0 },
      dangerText: { color: "#ef4444", fontSize: 12 },
      center: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, gap: 8, padding },
    }),
    [theme, padding],
  );

  if (query.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const error = data?.error ?? (query.isError ? String(query.error) : null);
  const hasData = !!issue || !!task;
  const taskActive = task ? !TERMINAL.has(task.status) : false;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Multica</Text>
        {data?.linked ? <Text style={styles.muted}>已关联</Text> : null}
        {instance ? <Text style={styles.muted}>{instance.label}</Text> : null}
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" style={styles.chip} onPress={() => void query.refetch()}>
          <Text style={styles.chipText}>刷新</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.muted}>{error}</Text> : null}

      {!hasData && !error ? (
        <Text style={styles.muted}>
          该会话还没有关联 Multica 卡片。在输入框输入 /multica-link &lt;卡片标识&gt; 关联。
        </Text>
      ) : null}

      {issue ? (
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.id}>{issue.identifier}</Text>
            <Text style={styles.muted}>{issue.statusName || issue.status}</Text>
            {issue.priority !== "none" ? (
              <Text style={{ color: (PRIORITY_META[issue.priority] ?? PRIORITY_META.none!).color, fontSize: 11 }}>
                {(PRIORITY_META[issue.priority] ?? PRIORITY_META.none!).label}
              </Text>
            ) : null}
            <View style={{ flex: 1 }} />
            <Text style={styles.muted}>{relativeTime(issue.updatedAt)}</Text>
          </View>
          <Text style={styles.issueTitle}>{issue.title}</Text>
          {issue.description?.trim() ? (
            <Text style={styles.desc} numberOfLines={4}>
              {previewMarkdown(issue.description)}
            </Text>
          ) : null}
        </View>
      ) : null}

      {task ? (
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.section}>任务</Text>
            <View style={[styles.chip, { borderColor: statusMeta(task.status).color }]}>
              <Text style={{ color: statusMeta(task.status).color, fontSize: 11 }}>
                {statusMeta(task.status).label}
              </Text>
            </View>
            <Text style={styles.muted}>
              {formatDuration(task.startedAt ?? task.dispatchedAt, task.completedAt)}
            </Text>
          </View>
          {task.triggerSummary ? (
            <Text style={styles.desc} numberOfLines={2}>
              {task.triggerSummary}
            </Text>
          ) : null}
          {task.error ? <Text style={{ color: "#ef4444", fontSize: 11 }}>{task.error}</Text> : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        {issueUrl ? (
          <Pressable
            accessibilityRole="button"
            style={styles.action}
            onPress={() => void openExternalUrl(issueUrl)}
          >
            <Text style={styles.actionText}>打开卡片</Text>
          </Pressable>
        ) : null}
        {task && taskActive ? (
          <Pressable
            accessibilityRole="button"
            disabled={cancel.isPending}
            style={[styles.action, styles.danger]}
            onPress={() => cancel.mutate(task.id)}
          >
            <Text style={styles.dangerText}>取消任务</Text>
          </Pressable>
        ) : null}
        {data?.linked ? (
          <Pressable
            accessibilityRole="button"
            disabled={unlink.isPending}
            style={styles.action}
            onPress={() => unlink.mutate()}
          >
            <Text style={styles.actionText}>解除关联</Text>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}