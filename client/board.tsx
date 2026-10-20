import { openExternalUrl, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, PanResponder, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { Issue, StatusRef } from "../shared/model";
import {
  boardProfilesRpc,
  boardSnapshotRpc,
  boardWorkspacesRpc,
  issuesCreateRpc,
  issuesUpdateRpc,
} from "../shared/rpc";

const FALLBACK_STATUSES: StatusRef[] = [
  { key: "backlog", name: "Backlog", category: "backlog", color: "#6b7280", position: 0, isSystem: true },
  { key: "todo", name: "Todo", category: "todo", color: "#3b82f6", position: 1, isSystem: true },
  { key: "in_progress", name: "In Progress", category: "in_progress", color: "#f59e0b", position: 2, isSystem: true },
  { key: "in_review", name: "In Review", category: "in_review", color: "#8b5cf6", position: 3, isSystem: true },
  { key: "blocked", name: "Blocked", category: "blocked", color: "#ef4444", position: 4, isSystem: true },
  { key: "done", name: "Done", category: "done", color: "#10b981", position: 5, isSystem: true },
  { key: "cancelled", name: "Cancelled", category: "cancelled", color: "#9ca3af", position: 6, isSystem: true },
];

const PRIORITY_META: Record<string, { label: string; color: string }> = {
  urgent: { label: "紧急", color: "#dc2626" },
  high: { label: "高", color: "#ef4444" },
  medium: { label: "中", color: "#f59e0b" },
  low: { label: "低", color: "#3b82f6" },
  none: { label: "无优先级", color: "#6b7280" },
};

function priorityMeta(priority: string): { label: string; color: string } {
  return PRIORITY_META[priority] ?? { label: priority, color: "#6b7280" };
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

function formatDateOnly(value: string): string {
  const [, month, day] = value.split("-");
  if (!month || !day) return value;
  return `${Number(month)}月${Number(day)}日`;
}

function todayLocalISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
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
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(time).toLocaleDateString("zh-CN");
}

export function MulticaBoardScreen({
  theme,
  layout,
  onOpenRuntime,
}: PluginScreenProps & { onOpenRuntime?: () => void }) {
  const queryClient = useQueryClient();
  const profilesRpc = useRpc(boardProfilesRpc);
  const workspacesRpc = useRpc(boardWorkspacesRpc);
  const boardSnapshot = useRpc(boardSnapshotRpc);
  const createIssue = useRpc(issuesCreateRpc);
  const updateIssue = useRpc(issuesUpdateRpc);

  const [profile, setProfile] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [addingStatus, setAddingStatus] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // 拖拽：card 在列之间移动即改状态。
  const [drag, setDrag] = useState<{ issue: Issue; from: string; fromIndex: number; startX: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const screenRef = useRef<View>(null);
  const screenOrigin = useRef({ x: 0, y: 0 });
  const ghost = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;

  const columnWidth = layout.compact ? 220 : 260;
  const columnGap = 12;
  const contentPadding = layout.compact ? 12 : 20;

  const profilesQuery = useQuery({ queryKey: ["multica-profiles"], queryFn: () => profilesRpc({}) });
  const workspacesQuery = useQuery({
    queryKey: ["multica-workspaces", profile],
    queryFn: () => workspacesRpc({ profile }),
  });

  const profiles = profilesQuery.data?.profiles ?? [];
  const workspaces = workspacesQuery.data?.workspaces ?? [];

  // 当前 profile 不在列表里（例如默认 profile 未登录）时，回退到第一个可用 profile。
  useEffect(() => {
    if (profiles.length === 0) return;
    if (profiles.some((item) => item.name === profile)) return;
    setProfile(profiles[0]!.name);
  }, [profiles, profile]);

  // 切换 profile 后重选工作区；默认优先用该 profile 记录的工作区。
  useEffect(() => {
    setWorkspaceId("");
  }, [profile]);

  useEffect(() => {
    if (workspaceId || workspaces.length === 0) return;
    const preferred = profiles.find((p) => p.name === profile)?.workspaceId;
    setWorkspaceId(workspaces.some((w) => w.id === preferred) ? preferred! : workspaces[0]!.id);
  }, [workspaceId, workspaces, profiles, profile]);

  const boardQuery = useQuery({
    queryKey: ["multica-board", profile, workspaceId],
    queryFn: () => boardSnapshot({ profile, workspaceId }),
    enabled: !!workspaceId,
  });

  const activeWorkspace = workspaces.find((w) => w.id === workspaceId);
  const activeProfile = profiles.find((p) => p.name === profile);
  const appUrl = activeProfile?.appUrl?.replace(/\/+$/, "") ?? "";
  const workspaceUrl = appUrl
    ? activeWorkspace?.slug
      ? `${appUrl}/${activeWorkspace.slug}/issues`
      : `${appUrl}/issues`
    : "";

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["multica-board"] });
  };

  const createMutation = useMutation({
    mutationFn: (vars: { title: string; status: string }) =>
      createIssue({ profile, workspaceId, title: vars.title, status: vars.status }),
    onSuccess: (result) => {
      setDraftTitle("");
      setAddingStatus(null);
      setNotice(`已创建 ${result.issue.identifier}`);
      invalidate();
    },
    onError: (error) => setNotice(errorText(error)),
  });

  const statusMutation = useMutation({
    mutationFn: (vars: { issueId: string; status: string }) =>
      updateIssue({ profile, workspaceId, issueId: vars.issueId, status: vars.status }),
    onSuccess: (result) => {
      setNotice(`${result.issue.identifier} → ${result.issue.status}`);
      invalidate();
    },
    onError: (error) => setNotice(errorText(error)),
  });

  const projectTitles = useMemo(
    () => new Map((boardQuery.data?.projects ?? []).map((project) => [project.id, project.title])),
    [boardQuery.data?.projects],
  );
  const agentNames = useMemo(
    () => new Map((boardQuery.data?.agents ?? []).map((agent) => [agent.id, agent.name])),
    [boardQuery.data?.agents],
  );
  const memberNames = useMemo(
    () => new Map((boardQuery.data?.members ?? []).map((member) => [member.id, member.name])),
    [boardQuery.data?.members],
  );

  // 拖动时的浮动卡片：把页面坐标换算到本屏容器内。
  const measureScreen = (): void => {
    const node = screenRef.current as unknown as
      | { measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void }
      | null;
    node?.measureInWindow?.((x, y) => {
      screenOrigin.current = { x, y };
    });
  };

  const placeGhost = (pageX: number, pageY: number): void => {
    ghost.setValue({
      x: pageX - screenOrigin.current.x - 24,
      y: pageY - screenOrigin.current.y - 14,
    });
  };

  const statuses = useMemo(() => {
    const list = boardQuery.data?.statuses?.length ? boardQuery.data.statuses : FALLBACK_STATUSES;
    return [...list].sort((a, b) => a.position - b.position);
  }, [boardQuery.data?.statuses]);

  const grouped = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const status of statuses) map.set(status.key, []);
    for (const issue of boardQuery.data?.issues ?? []) {
      const bucket = map.get(issue.status);
      if (bucket) bucket.push(issue);
      else if (map.size > 0) map.get(statuses[0]?.key ?? "")?.push(issue);
    }
    return map;
  }, [boardQuery.data?.issues, statuses]);

  // 指针位移 → 目标列：以起始列为中心，每移动约一个列宽切换一列。
  const statusAtDelta = (fromIndex: number, deltaX: number): string | null => {
    if (statuses.length === 0) return null;
    const steps = Math.round(deltaX / (columnWidth + columnGap));
    const clamped = Math.min(Math.max(fromIndex + steps, 0), statuses.length - 1);
    return statuses[clamped]?.key ?? null;
  };

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: contentPadding,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        flexWrap: "wrap" as const,
      },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      groupLabel: { color: theme.colors.foregroundMuted, fontSize: 11 },
      groupDivider: { width: 1, height: 16, backgroundColor: theme.colors.border, marginHorizontal: 2 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
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
      input: {
        flex: 1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        fontSize: 12,
      },
      columns: { flex: 1 },
      columnsContent: { paddingHorizontal: contentPadding, gap: columnGap, paddingVertical: 12 },
      column: {
        width: columnWidth,
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        padding: 8,
        // 常驻透明描边，拖动高亮时只换颜色，避免列宽跳动。
        borderWidth: 2,
        borderColor: "transparent",
      },
      columnOver: { borderColor: theme.colors.accent },
      columnHead: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        alignItems: "center" as const,
        paddingHorizontal: 4,
        paddingBottom: 6,
        gap: 6,
      },
      columnTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      headRight: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      addBtn: {
        width: 20,
        height: 20,
        borderRadius: 6,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface0,
      },
      addBtnText: { color: theme.colors.foreground, fontSize: 14, lineHeight: 16 },
      addRow: { flexDirection: "row" as const, gap: 6, paddingBottom: 6, alignItems: "center" as const },
      card: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        padding: 8,
        marginBottom: 6,
        gap: 4,
        borderLeftWidth: 3,
      },
      cardDrop: { opacity: 0.5 },
      cardRow: { flexDirection: "row" as const, gap: 6, alignItems: "flex-start" as const },
      handle: {
        width: 18,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        opacity: 0.6,
        userSelect: "none" as const,
        cursor: "grab" as const,
      },
      handleText: { color: theme.colors.foregroundMuted, fontSize: 13 },
      cardBody: { flex: 1, gap: 3 },
      cardTop: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 6,
      },
      cardTopLeft: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
      priorityDot: { width: 6, height: 6, borderRadius: 3 },
      cardPriority: { fontSize: 11, fontWeight: "600" as const },
      cardDesc: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
      chipRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, flexWrap: "wrap" as const },
      cardChip: {
        maxWidth: 150,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 999,
        backgroundColor: theme.colors.surface0,
      },
      cardChipText: { color: theme.colors.foregroundMuted, fontSize: 10 },
      labelChip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 3,
        maxWidth: 120,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 999,
        backgroundColor: theme.colors.surface0,
      },
      labelDot: { width: 6, height: 6, borderRadius: 3 },
      labelText: { color: theme.colors.foreground, fontSize: 10 },
      labelMore: { color: theme.colors.foregroundMuted, fontSize: 10 },
      metaRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 6,
        marginTop: 2,
      },
      assignee: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, flex: 1, minWidth: 0 },
      avatar: {
        width: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      avatarText: { color: theme.colors.foreground, fontSize: 9 },
      assigneeText: { color: theme.colors.foreground, fontSize: 11, flexShrink: 1 },
      metaRight: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexShrink: 0 },
      dateText: { color: theme.colors.foregroundMuted, fontSize: 10 },
      overdue: { color: "#ef4444" },
      mutedSmall: { color: theme.colors.foregroundMuted, fontSize: 10 },
      cardId: { color: theme.colors.foregroundMuted, fontSize: 11 },
      cardTitle: { color: theme.colors.foreground, fontSize: 13 },
      cardMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      actionRow: { flexDirection: "row" as const, gap: 6, marginTop: 4, flexWrap: "wrap" as const },
      action: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface0,
      },
      actionText: { color: theme.colors.foreground, fontSize: 11 },
      notice: {
        color: theme.colors.foreground,
        fontSize: 12,
        paddingHorizontal: contentPadding,
        paddingVertical: 6,
      },
      center: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, gap: 8 },
      ghost: {
        position: "absolute" as const,
        left: 0,
        top: 0,
        width: columnWidth - 24,
        zIndex: 100,
      },
      ghostCard: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 8,
        padding: 10,
        borderLeftWidth: 3,
        opacity: 0.95,
        gap: 2,
      },
    }),
    [theme, layout.compact, columnWidth, contentPadding, columnGap],
  );

  const busy = createMutation.isPending || statusMutation.isPending;

  const submitCreate = (status: string): void => {
    const title = draftTitle.trim();
    if (!title) return;
    createMutation.mutate({ title, status });
  };

  const startDrag = (issue: Issue, pageX: number, pageY: number): void => {
    const fromIndex = Math.max(
      statuses.findIndex((status) => status.key === issue.status),
      0,
    );
    measureScreen();
    placeGhost(pageX, pageY);
    setDrag({ issue, from: issue.status, fromIndex, startX: pageX });
    setHover(issue.status);
  };

  const endDrag = (): void => {
    if (drag && hover && hover !== drag.from) {
      statusMutation.mutate({ issueId: drag.issue.id, status: hover });
    }
    setDrag(null);
    setHover(null);
  };

  if (profilesQuery.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (profiles.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>尚未找到 Multica profile</Text>
        <Text style={styles.muted}>请先在终端运行 multica setup 完成登录。</Text>
      </View>
    );
  }

  return (
    <View ref={screenRef} onLayout={measureScreen} style={styles.screen}>
      <View style={styles.bar}>
        <Text style={styles.title}>Multica</Text>
        <View style={{ flex: 1 }} />
        {onOpenRuntime ? (
          <Pressable accessibilityRole="button" onPress={onOpenRuntime} style={styles.chip}>
            <Text style={styles.chipText}>运行时接入</Text>
          </Pressable>
        ) : null}
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
        {workspacesQuery.data?.error ? (
          <Text style={styles.muted}>{workspacesQuery.data.error}</Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={() => void boardQuery.refetch()}
          style={styles.chip}
        >
          <Text style={styles.chipText}>刷新</Text>
        </Pressable>
        {workspaceUrl ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void openExternalUrl(workspaceUrl)}
            style={styles.chip}
          >
            <Text style={styles.chipText}>网页</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.notice}>
        {activeProfile ? `Profile ${activeProfile.label}` : ""}
        {activeWorkspace ? ` · 工作区 ${activeWorkspace.name}` : ""}
        {activeProfile ? ` · ${activeProfile.serverUrl}` : ""}
      </Text>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      {!workspaceId ? (
        <View style={styles.center}>
          <Text style={styles.muted}>请选择工作区</Text>
        </View>
      ) : boardQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : boardQuery.isError ? (
        <View style={styles.center}>
          <Text style={styles.muted}>{errorText(boardQuery.error)}</Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          scrollEnabled={!drag}
          style={styles.columns}
          contentContainerStyle={styles.columnsContent}
          showsHorizontalScrollIndicator
        >
          {statuses.map((status) => {
            const items = grouped.get(status.key) ?? [];
            const isTarget = !!drag && hover === status.key && drag.from !== status.key;
            return (
              <View key={status.key} style={[styles.column, isTarget ? styles.columnOver : null]}>
                <View style={styles.columnHead}>
                  <Text style={styles.columnTitle}>{status.name}</Text>
                  <View style={styles.headRight}>
                    <Text style={styles.muted}>{items.length}</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        setAddingStatus((current) => (current === status.key ? null : status.key));
                        setDraftTitle("");
                      }}
                      style={styles.addBtn}
                    >
                      <Text style={styles.addBtnText}>+</Text>
                    </Pressable>
                  </View>
                </View>

                {addingStatus === status.key ? (
                  <View style={styles.addRow}>
                    <TextInput
                      autoFocus
                      style={styles.input}
                      placeholder="卡片标题"
                      placeholderTextColor={theme.colors.foregroundMuted}
                      value={draftTitle}
                      onChangeText={setDraftTitle}
                      onSubmitEditing={() => submitCreate(status.key)}
                    />
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => submitCreate(status.key)}
                      style={styles.chip}
                    >
                      <Text style={styles.chipText}>创建</Text>
                    </Pressable>
                  </View>
                ) : null}

                <ScrollView scrollEnabled={!drag} showsVerticalScrollIndicator>
                  {items.map((issue) => (
                    <DraggableCard
                      key={issue.id}
                      issue={issue}
                      accent={status.color || theme.colors.border}
                      dragging={drag?.issue.id === issue.id}
                      styles={styles}
                      projectName={
                        issue.projectId ? projectTitles.get(issue.projectId) : undefined
                      }
                      assigneeName={
                        issue.assigneeType === "agent"
                          ? agentNames.get(issue.assigneeId ?? "")
                          : issue.assigneeType === "member"
                            ? memberNames.get(issue.assigneeId ?? "")
                            : issue.assigneeType === "squad"
                              ? "小队"
                              : undefined
                      }
                      onDragStart={startDrag}
                      onDragMove={(pageX, pageY) => {
                        placeGhost(pageX, pageY);
                        if (drag) setHover(statusAtDelta(drag.fromIndex, pageX - drag.startX));
                      }}
                      onDragEnd={endDrag}
                      onOpenWeb={() => {
                        const url = relativeIssueUrl(
                          boardQuery.data?.instance.appUrl,
                          activeWorkspace?.slug ?? boardQuery.data?.instance.workspaceSlug,
                          issue.identifier,
                        );
                        if (url) void openExternalUrl(url);
                      }}
                    />
                  ))}
                  {items.length === 0 ? <Text style={styles.muted}>—</Text> : null}
                </ScrollView>
              </View>
            );
          })}
        </ScrollView>
      )}

      {drag ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.ghost, { transform: [...ghost.getTranslateTransform(), { rotate: "-2deg" }] }]}
        >
          <View
            style={[
              styles.ghostCard,
              {
                borderLeftColor:
                  statuses.find((status) => status.key === drag.issue.status)?.color ?? theme.colors.border,
              },
            ]}
          >
            <Text style={styles.cardId}>{drag.issue.identifier}</Text>
            <Text style={styles.cardTitle}>{drag.issue.title}</Text>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

// 卡片：左侧「≡」手柄拖动；松手由父组件决定目标列并改状态。
function DraggableCard({
  issue,
  accent,
  dragging,
  styles,
  projectName,
  assigneeName,
  onDragStart,
  onDragMove,
  onDragEnd,
  onOpenWeb,
}: {
  issue: Issue;
  accent: string;
  dragging: boolean;
  styles: Record<string, object>;
  projectName?: string;
  assigneeName?: string;
  onDragStart: (issue: Issue, pageX: number, pageY: number) => void;
  onDragMove: (pageX: number, pageY: number) => void;
  onDragEnd: () => void;
  onOpenWeb: () => void;
}) {
  const latest = useRef({ issue, onDragStart, onDragMove, onDragEnd });
  latest.current = { issue, onDragStart, onDragMove, onDragEnd };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // 祖先 ScrollView 会尝试接管手势；拒绝终止，拖拽才能持续。
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (event) => {
          latest.current.onDragStart(
            latest.current.issue,
            event.nativeEvent.pageX,
            event.nativeEvent.pageY,
          );
        },
        onPanResponderMove: (event, gesture) => {
          const pageX = gesture.moveX || event.nativeEvent.pageX || 0;
          const pageY = gesture.moveY || event.nativeEvent.pageY || 0;
          latest.current.onDragMove(pageX, pageY);
        },
        onPanResponderRelease: () => latest.current.onDragEnd(),
        onPanResponderTerminate: () => latest.current.onDragEnd(),
      }),
    [],
  );

  return (
    <View style={[styles.card, { borderLeftColor: accent }, dragging ? styles.cardDrop : null]}>
      <View style={styles.cardRow}>
        <View {...pan.panHandlers} style={styles.handle}>
          <Text style={styles.handleText}>≡</Text>
        </View>
        <View style={styles.cardBody}>
          <View style={styles.cardTop}>
            <View style={styles.cardTopLeft}>
              {issue.priority !== "none" ? (
                <>
                  <View
                    style={[styles.priorityDot, { backgroundColor: priorityMeta(issue.priority).color }]}
                  />
                  <Text style={[styles.cardPriority, { color: priorityMeta(issue.priority).color }]}>
                    {priorityMeta(issue.priority).label}
                  </Text>
                </>
              ) : null}
              <Text style={styles.cardId}>{issue.identifier}</Text>
            </View>
          </View>

          <Text style={styles.cardTitle} numberOfLines={2}>
            {issue.title}
          </Text>

          {issue.description?.trim() ? (
            <Text style={styles.cardDesc} numberOfLines={2}>
              {previewMarkdown(issue.description)}
            </Text>
          ) : null}

          {projectName || issue.labels.length > 0 ? (
            <View style={styles.chipRow}>
              {projectName ? (
                <View style={styles.cardChip}>
                  <Text style={styles.cardChipText} numberOfLines={1}>
                    {projectName}
                  </Text>
                </View>
              ) : null}
              {issue.labels.slice(0, 2).map((label) => (
                <View key={label.id} style={styles.labelChip}>
                  <View style={[styles.labelDot, { backgroundColor: label.color }]} />
                  <Text style={styles.labelText} numberOfLines={1}>
                    {label.name}
                  </Text>
                </View>
              ))}
              {issue.labels.length > 2 ? (
                <Text style={styles.labelMore}>+{issue.labels.length - 2}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={styles.metaRow}>
            {assigneeName ? (
              <View style={styles.assignee}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{assigneeName.slice(0, 1).toUpperCase()}</Text>
                </View>
                <Text style={styles.assigneeText} numberOfLines={1}>
                  {assigneeName}
                </Text>
              </View>
            ) : (
              <Text style={styles.mutedSmall}>未指派</Text>
            )}
            <View style={styles.metaRight}>
              {issue.startDate ? (
                <Text style={styles.dateText}>{formatDateOnly(issue.startDate)}</Text>
              ) : null}
              {issue.dueDate ? (
                <Text
                  style={[styles.dateText, issue.dueDate < todayLocalISO() ? styles.overdue : null]}
                >
                  {formatDateOnly(issue.dueDate)}
                </Text>
              ) : null}
              <Text style={styles.mutedSmall}>{relativeTime(issue.updatedAt)}</Text>
            </View>
          </View>
        </View>
      </View>
      <View style={styles.actionRow}>
        <Pressable accessibilityRole="button" style={styles.action} onPress={onOpenWeb}>
          <Text style={styles.actionText}>网页</Text>
        </Pressable>
      </View>
    </View>
  );
}

function relativeIssueUrl(appUrl: string | undefined, slug: string | undefined, identifier: string): string {
  if (!appUrl) return "";
  const base = appUrl.replace(/\/+$/, "");
  return slug ? `${base}/${slug}/issues/${identifier}` : `${base}/issues/${identifier}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}