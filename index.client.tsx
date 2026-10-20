import { useState } from "react";
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { multicaIssueSource } from "./shared/attachment";
import { linksClearRpc, linksSetRpc } from "./shared/rpc";
import { MulticaBoardScreen } from "./client/board";
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

  return () => {};
}