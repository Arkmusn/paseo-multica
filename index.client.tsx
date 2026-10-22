import { useState } from "react";
import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { multicaIssueSource } from "./shared/attachment";
import { linksClearRpc, linksSetRpc } from "./shared/rpc";
import { MulticaAgentPanel } from "./client/agent-panel";
import { MulticaBoardScreen } from "./client/board";
import { MulticaTasksScreen } from "./client/tasks";
import { RuntimeScreen } from "./client/runtime";
import { MulticaSettingsScreen } from "./client/settings";

function MulticaSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="SquareKanban"
      active={currentScreen?.screenId === "board"}
      onPress={() => openScreen({ screenId: "board" })}
    />
  );
}

function TasksSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ListChecks"
      active={currentScreen?.screenId === "tasks"}
      onPress={() => openScreen({ screenId: "tasks" })}
    />
  );
}

// 看板为主体；「运行时接入」作为同一屏内的视图切换。
function MulticaScreen(props: PluginScreenProps) {
  const [view, setView] = useState<"board" | "runtime">("board");
  return view === "runtime" ? (
    <RuntimeScreen {...props} onBack={() => setView("board")} />
  ) : (
    <MulticaBoardScreen {...props} onOpenRuntime={() => setView("runtime")} />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "board", title: "Multica", Component: MulticaScreen });
  client.addSidebarHeaderItem({ id: "board", title: "Multica", Component: MulticaSidebarItem });
  client.addScreen({ id: "tasks", title: "本机任务", Component: MulticaTasksScreen });
  client.addWorkspacePanel({
    id: "multica-agent",
    title: "Multica",
    icon: "SquareKanban",
    context: "agent",
    Component: MulticaAgentPanel,
  });
  client.addSidebarHeaderItem({ id: "tasks", title: "本机任务", Component: TasksSidebarItem });
  client.addSettingsScreen({
    id: "settings",
    title: "Multica",
    icon: "Settings",
    Component: MulticaSettingsScreen,
  });

  client.addAttachmentSource(multicaIssueSource);

  client.addCommandCenterItem({
    id: "open-board",
    title: "打开 Multica",
    icon: "SquareKanban",
    keywords: ["multica", "看板", "kanban", "issue", "运行时", "runtime"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "board" });
    },
  });

  client.addCommandCenterItem({
    id: "open-tasks",
    title: "打开本机任务",
    icon: "ListChecks",
    keywords: ["multica", "任务", "task", "runtime", "本机"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "tasks" });
    },
  });

  client.addCommandCenterItem({
    id: "open-agent-panel",
    title: "打开 Multica 面板",
    icon: "SquareKanban",
    keywords: ["multica", "面板", "panel", "issue", "任务"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("multica-agent");
    },
  });

  client.addSlashCommand({
    name: "multica-link",
    description: "把当前会话关联到一张 Multica 卡片（标识如 PUCK-5）",
    argumentHint: "<卡片标识>",
    context: "agent",
    async onSubmit({ args, agent, rpc }) {
      const issueRef = args.trim();
      if (!issueRef) return;
      await rpc(linksSetRpc, { agentId: agent.id, issueRef });
    },
  });

  client.addSlashCommand({
    name: "multica-unlink",
    description: "解除当前会话与 Multica 卡片的关联",
    argumentHint: "",
    context: "agent",
    async onSubmit({ agent, rpc }) {
      await rpc(linksClearRpc, { agentId: agent.id });
    },
  });

  // 每个 agent 的输入框旁加一个 Multica 药丸，点开看关联卡片/任务。
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const registerPill = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    pills.get(agentId)?.remove();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "multica",
        workspaceId,
        agentId,
        button: {
          title: "Multica",
          icon: "SquareKanban",
          label: "Multica",
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel("multica-agent", { workspaceId, agentId });
            },
          },
        },
      }),
    );
  };
  const removePills = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removePills();
          for (const { agent } of entries) registerPill(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return registerPill(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Multica: agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    removePills();
  };
}