import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsGroup, SettingsRow, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { multicaSettings, type MulticaInstanceConfig, type MulticaSettingsValues } from "../shared/model";
import { instanceTestRpc } from "../shared/rpc";

function blankInstance(index: number): MulticaInstanceConfig {
  return {
    id: `multica-${index + 1}`,
    label: "",
    serverUrl: "http://localhost:8080",
    appUrl: "",
    workspaceId: "",
    workspaceSlug: "",
    configPath: "~/.multica/config.json",
    token: "",
    writeBack: false,
  };
}

export function MulticaSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(multicaSettings);
  const test = useRpc(instanceTestRpc);
  const [draft, setDraft] = useState<MulticaSettingsValues | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    if (settings.status === "ready" && draft === null) {
      setDraft(settings.values);
    }
  }, [settings, draft]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 20, gap: 12 },
      input: {
        flex: 1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        minWidth: 180,
      },
      rowText: { color: theme.colors.foreground, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const, alignItems: "center" as const },
      chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border },
      chipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 12 },
      chipTextActive: { color: theme.colors.accentForeground, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  if (settings.status === "loading") {
    return (
      <View style={styles.screen}>
        <Text style={[styles.muted, { padding: 20 }]}>加载中…</Text>
      </View>
    );
  }

  if (settings.status === "error") {
    return (
      <View style={styles.screen}>
        <Text style={[styles.error, { padding: 20 }]}>{settings.error}</Text>
      </View>
    );
  }

  if (settings.status === "invalid") {
    return (
      <View style={styles.screen}>
        <Text style={[styles.error, { padding: 20 }]}>设置数据无效：{settings.error}</Text>
        <SettingsGroup title="恢复">
          <SettingsAction label="重置为默认" actionLabel="重置" onPress={() => void settings.reset()} />
        </SettingsGroup>
      </View>
    );
  }

  const values = draft ?? settings.values;

  const update = (index: number, patch: Partial<MulticaInstanceConfig>) => {
    const next = values.instances.map((inst, i) => (i === index ? { ...inst, ...patch } : inst));
    setDraft({ ...values, instances: next });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SettingsGroup title="Multica 实例" info="可配置多个实例；token 留空时从配置文件读取。">
        {values.instances.map((inst, index) => (
          <View key={inst.id} style={{ gap: 8 }}>
            <View style={styles.actions}>
              <Text style={styles.rowText}>#{index + 1}</Text>
              <Pressable
                accessibilityRole="button"
                style={[styles.chip, values.activeId === inst.id ? styles.chipActive : null]}
                onPress={() => setDraft({ ...values, activeId: inst.id })}
              >
                <Text style={values.activeId === inst.id ? styles.chipTextActive : styles.chipText}>
                  {values.activeId === inst.id ? "当前实例" : "设为当前"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={styles.chip}
                onPress={() => {
                  const next = values.instances.filter((_, i) => i !== index);
                  setDraft({
                    ...values,
                    instances: next,
                    activeId: values.activeId === inst.id ? (next[0]?.id ?? "") : values.activeId,
                  });
                }}
              >
                <Text style={styles.chipText}>移除</Text>
              </Pressable>
            </View>
            <SettingsRow label="标识 (id)">
              <TextInput style={styles.input} value={inst.id} onChangeText={(text) => update(index, { id: text })} />
            </SettingsRow>
            <SettingsRow label="名称">
              <TextInput
                style={styles.input}
                placeholder="显示名称"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={inst.label}
                onChangeText={(text) => update(index, { label: text })}
              />
            </SettingsRow>
            <SettingsRow label="Server URL">
              <TextInput style={styles.input} value={inst.serverUrl} onChangeText={(text) => update(index, { serverUrl: text })} />
            </SettingsRow>
            <SettingsRow label="Web App URL" hint="用于“网页”跳转">
              <TextInput style={styles.input} value={inst.appUrl} onChangeText={(text) => update(index, { appUrl: text })} />
            </SettingsRow>
            <SettingsRow label="工作区 ID" hint="可留空，默认取配置文件">
              <TextInput style={styles.input} value={inst.workspaceId} onChangeText={(text) => update(index, { workspaceId: text })} />
            </SettingsRow>
            <SettingsRow label="工作区 Slug" hint="可留空，会自动解析">
              <TextInput style={styles.input} value={inst.workspaceSlug} onChangeText={(text) => update(index, { workspaceSlug: text })} />
            </SettingsRow>
            <SettingsRow label="CLI 配置路径" hint="从中继承 workspace/token">
              <TextInput style={styles.input} value={inst.configPath} onChangeText={(text) => update(index, { configPath: text })} />
            </SettingsRow>
            <SettingsRow label="Token" hint="留空则读取配置文件；非空则覆盖">
              <TextInput
                style={styles.input}
                placeholder="mul_..."
                placeholderTextColor={theme.colors.foregroundMuted}
                secureTextEntry
                value={inst.token}
                onChangeText={(text) => update(index, { token: text })}
              />
            </SettingsRow>
            <SettingsSwitch
              label="会话结束回写"
              hint="Paseo 会话结束时把结果评论回写卡片"
              value={inst.writeBack}
              onValueChange={(value) => update(index, { writeBack: value })}
            />
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                style={styles.chip}
                onPress={() => {
                  void test({ instanceId: inst.id })
                    .then((result) => {
                      setTestResults((prev) => ({
                        ...prev,
                        [inst.id]: result.ok
                          ? `连接正常：${result.userEmail ?? ""} @ ${result.workspaceName ?? ""}`
                          : `失败：${result.error ?? "未知错误"}`,
                      }));
                    })
                    .catch((error) => {
                      setTestResults((prev) => ({ ...prev, [inst.id]: errorText(error) }));
                    });
                }}
              >
                <Text style={styles.chipText}>测试连接</Text>
              </Pressable>
              <Text style={styles.muted}>{testResults[inst.id] ?? ""}</Text>
            </View>
          </View>
        ))}
        <SettingsAction
          label="添加实例"
          hint="新增一个 Multica 服务器连接"
          actionLabel="添加"
          onPress={() => setDraft({ ...values, instances: [...values.instances, blankInstance(values.instances.length)] })}
        />
      </SettingsGroup>

      <SettingsGroup title="保存">
        {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
        <SettingsAction
          label="保存设置"
          actionLabel={settings.saving ? "保存中…" : "保存"}
          disabled={settings.saving}
          onPress={() => {
            void settings.save(values, settings.revision).then((ok) => {
              if (ok) setDraft(null);
            });
          }}
        />
        <SettingsAction
          label="放弃改动"
          actionLabel="重载"
          onPress={() => {
            setDraft(null);
            void settings.reload();
          }}
        />
      </SettingsGroup>
    </ScrollView>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}