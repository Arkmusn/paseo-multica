import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsGroup, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { multicaSettings } from "../shared/model";
import {
  profileCreateRpc,
  profilesListRpc,
  runtimeProvisionRpc,
  runtimeStatusRpc,
  runtimeTeardownRpc,
  type Profile,
  type ProvisionStep,
  type RuntimeStatus,
} from "../shared/provision";

function dot(ok: boolean): string {
  return ok ? "●" : "○";
}

export function RuntimeScreen({ theme, layout, onBack }: PluginSurfaceProps & { onBack?: () => void }) {
  const settings = useSettings(multicaSettings);
  const status = useRpc(runtimeStatusRpc);
  const provision = useRpc(runtimeProvisionRpc);
  const teardown = useRpc(runtimeTeardownRpc);
  const [state, setState] = useState<RuntimeStatus | null>(null);
  const [steps, setSteps] = useState<ProvisionStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState("");
  const profilesRpc = useRpc(profilesListRpc);
  const createRpc = useRpc(profileCreateRpc);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [creating, setCreating] = useState(false);
  const [createSteps, setCreateSteps] = useState<ProvisionStep[] | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [teardownMsg, setTeardownMsg] = useState<string | null>(null);
  const [np, setNp] = useState({ name: "", serverUrl: "", appUrl: "", workspaceId: "", token: "" });

  const loadProfiles = useCallback(() => {
    void profilesRpc({})
      .then((value) => setProfiles(value.profiles))
      .catch(() => setProfiles([]));
  }, [profilesRpc]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const createProfile = () => {
    setCreating(true);
    setCreateSteps(null);
    setCreateError(null);
    void createRpc({
      name: np.name.trim(),
      serverUrl: np.serverUrl.trim(),
      appUrl: np.appUrl.trim() || undefined,
      workspaceId: np.workspaceId.trim() || undefined,
      token: np.token.trim() || undefined,
    })
      .then((result) => {
        setCreateSteps(result.steps);
        setCreateError(result.ok ? null : result.error);
        if (result.ok) {
          setProfileDraft(np.name.trim());
          setNp({ name: "", serverUrl: "", appUrl: "", workspaceId: "", token: "" });
          loadProfiles();
        }
      })
      .catch((e) => setCreateError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCreating(false));
  };

  const runTeardown = () => {
    setTeardownMsg(null);
    void teardown({})
      .then((result) => {
        setTeardownMsg(
          result.removed
            ? `已移除：${result.path}`
            : result.error || "未移除（wrapper 不存在或不属于本插件）",
        );
        refresh();
      })
      .catch((e) => setTeardownMsg(e instanceof Error ? e.message : String(e)));
  };

  const refresh = useCallback(() => {
    setError(null);
    void status({})
      .then((value) => setState(value))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [status]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (settings.status === "ready") {
      setProfileDraft((prev) => (prev === "" ? settings.values.runtime.profile : prev));
    }
  }, [settings]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 20, gap: 12 },
      mono: { color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      okText: { color: theme.colors.foreground, fontSize: 12 },
      chip: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      chipText: { color: theme.colors.foreground, fontSize: 12 },
      chipActive: { borderColor: theme.colors.foreground, borderWidth: 2 },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      input: {
        flex: 1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        minWidth: 160,
      },
      steps: { gap: 4 },
    }),
    [theme, layout.compact],
  );

  const cfg = settings.status === "ready" ? settings.values.runtime : null;

  const run = () => {
    setBusy(true);
    setSteps(null);
    setError(null);
    void provision({ profile: profileDraft.trim() })
      .then((result) => {
        setSteps(result.steps);
        refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {onBack ? (
        <View style={styles.chips}>
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.chip}>
            <Text style={styles.chipText}>← 返回看板</Text>
          </Pressable>
        </View>
      ) : null}
      <SettingsGroup title="Paseo → Multica 运行时接入" info="把本机 Paseo 作为自定义 Multica 运行时接进去，让 Multica 派发的任务由 Paseo 执行。">
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {state ? (
          <View style={styles.steps}>
            <SettingsRow label="Multica profile">
              <Text style={styles.mono}>{state.profileName || "（默认 profile）"}</Text>
            </SettingsRow>
            <SettingsRow label="multica CLI">
              <Text style={styles.mono}>
                {dot(state.multicaCli.present)} {state.multicaCli.path || "未找到"}
              </Text>
            </SettingsRow>
            <SettingsRow label="harness">
              <Text style={styles.mono}>
                {dot(state.harness.present)} {state.harness.path}
              </Text>
            </SettingsRow>
            <SettingsRow label="PATH 目录">
              <Text style={styles.mono}>
                {dot(state.binDir.writable)} {state.binDir.path || "无"}
              </Text>
            </SettingsRow>
            <SettingsRow label="wrapper">
              <Text style={styles.mono}>
                {dot(state.wrapper.present)} {state.wrapper.path || "—"}
              </Text>
            </SettingsRow>
            <SettingsRow label="runtime profile">
              <Text style={styles.mono}>
                {state.profile
                  ? `${dot(true)} ${state.profile.displayName} · ${state.profile.protocolFamily} · ${state.profile.id}`
                  : `${dot(false)} 未注册`}
              </Text>
            </SettingsRow>
            <SettingsRow label="runtime">
              <Text style={styles.mono}>
                {state.runtime
                  ? `${dot(state.runtime.status === "online")} ${state.runtime.launchHeader} · ${state.runtime.status}`
                  : `${dot(false)} 未上线`}
              </Text>
            </SettingsRow>
            <SettingsRow label="agent">
              <Text style={styles.mono}>
                {state.agent ? `${dot(true)} ${state.agent.name} · ${state.agent.id}` : `${dot(false)} 未创建`}
              </Text>
            </SettingsRow>
          </View>
        ) : (
          <Text style={styles.muted}>读取中…</Text>
        )}
      </SettingsGroup>

      {cfg ? (
        <SettingsGroup title="将使用的配置" info="路径与名称可在「设置 → Multica」的运行时区块修改。">
          <SettingsRow label="命令名">
            <Text style={styles.mono}>{cfg.commandName}</Text>
          </SettingsRow>
          <SettingsRow label="协议族">
            <Text style={styles.mono}>{cfg.runtimeType}</Text>
          </SettingsRow>
          <SettingsRow label="显示名">
            <Text style={styles.mono}>{cfg.displayName}</Text>
          </SettingsRow>
          <SettingsRow label="agent 名">
            <Text style={styles.mono}>{cfg.agentName}</Text>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="目标 Multica profile" info="选择本机已有 profile；空=默认 profile。可把本机 Paseo 接入到另一台 Multica daemon。">
        <SettingsRow label="当前选择">
          <Text style={styles.mono}>{profileDraft.trim() || "（默认 profile）"}</Text>
        </SettingsRow>
        <SettingsRow label="可选">
          <View style={styles.chips}>
            <Pressable
              onPress={() => setProfileDraft("")}
              style={[styles.chip, profileDraft.trim() === "" && styles.chipActive]}
            >
              <Text style={styles.chipText}>{profileDraft.trim() === "" ? "✓ " : ""}默认</Text>
            </Pressable>
            {profiles
              .filter((p) => !p.isDefault)
              .map((p) => {
                const active = profileDraft.trim() === p.name;
                return (
                  <Pressable
                    key={p.name}
                    onPress={() => setProfileDraft(p.name)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={styles.chipText}>
                      {active ? "✓ " : ""}
                      {p.name}
                    </Text>
                  </Pressable>
                );
              })}
            {profiles.filter((p) => !p.isDefault).length === 0 ? (
              <Text style={styles.muted}>（本机暂无具名 profile）</Text>
            ) : null}
          </View>
        </SettingsRow>
        {profiles.length > 0 ? (
          <Text style={styles.muted}>
            {profiles
              .map((p) => `${p.isDefault ? "(默认)" : p.name} → ${p.serverUrl || "未配置 server"}`)
              .join("\n")}
          </Text>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="新建 profile" info="写入 server/app/workspace 并用 PAT 登录，全程非交互；token 可留空，之后再补 multica login。">
        <SettingsRow label="名称">
          <TextInput
            style={styles.input}
            placeholder="如 dev"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={np.name}
            onChangeText={(v) => setNp({ ...np, name: v })}
          />
        </SettingsRow>
        <SettingsRow label="server_url">
          <TextInput
            style={styles.input}
            placeholder="http://localhost:60778"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={np.serverUrl}
            onChangeText={(v) => setNp({ ...np, serverUrl: v })}
          />
        </SettingsRow>
        <SettingsRow label="app_url">
          <TextInput
            style={styles.input}
            placeholder="http://localhost:60777（可空）"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={np.appUrl}
            onChangeText={(v) => setNp({ ...np, appUrl: v })}
          />
        </SettingsRow>
        <SettingsRow label="workspace_id">
          <TextInput
            style={styles.input}
            placeholder="可空"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={np.workspaceId}
            onChangeText={(v) => setNp({ ...np, workspaceId: v })}
          />
        </SettingsRow>
        <SettingsRow label="token (PAT)">
          <TextInput
            style={styles.input}
            placeholder="mul_...（可空）"
            placeholderTextColor={theme.colors.foregroundMuted}
            secureTextEntry
            value={np.token}
            onChangeText={(v) => setNp({ ...np, token: v })}
          />
        </SettingsRow>
        <SettingsAction
          label="创建 profile"
          hint="multica --profile <名> config set … + login --token …"
          actionLabel={creating ? "创建中…" : "创建"}
          disabled={creating || np.name.trim() === "" || np.serverUrl.trim() === ""}
          onPress={createProfile}
        />
        {createError ? <Text style={styles.error}>{createError}</Text> : null}
        {createSteps ? (
          <View style={styles.steps}>
            {createSteps.map((s, i) => (
              <View key={`${s.name}-${i}`} style={styles.steps}>
                <Text style={s.ok ? styles.okText : styles.muted}>
                  {dot(s.ok)} {s.name}
                </Text>
                <Text style={styles.muted}>{s.detail}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="操作">
        <SettingsAction
          label="一键接入（幂等）"
          hint="落 wrapper → 注册 profile → 重启 daemon → 建 agent"
          actionLabel={busy ? "执行中…" : "接入"}
          disabled={busy}
          onPress={run}
        />
        <SettingsAction label="刷新状态" actionLabel="刷新" onPress={refresh} />
        <SettingsAction
          label="移除本机接入"
          hint="删除 PATH 里的 wrapper；Multica 侧的 runtime/agent 保留"
          actionLabel="移除"
          onPress={runTeardown}
        />
        {teardownMsg ? <Text style={styles.muted}>{teardownMsg}</Text> : null}
      </SettingsGroup>

      {steps ? (
        <SettingsGroup title="执行结果">
          <View style={styles.steps}>
            {steps.map((step, index) => (
              <View key={`${step.name}-${index}`} style={styles.steps}>
                <Text style={step.ok ? styles.okText : styles.error}>
                  {dot(step.ok)} {step.name}
                </Text>
                <Text style={styles.muted}>{step.detail}</Text>
              </View>
            ))}
          </View>
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

