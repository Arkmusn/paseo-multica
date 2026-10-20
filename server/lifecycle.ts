import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { MulticaSettingsSchema } from "../shared/model";
import { resolveInstances } from "./config";
import { getLink } from "./links";
import { MulticaClient } from "./multica";

// 从时间线里尽力提取最近一段助手文本。时间线条目类型由宿主提供，这里只做防御性读取。
function latestText(timeline: readonly unknown[]): string {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item && typeof item === "object") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        return text.trim().slice(0, 4000);
      }
    }
  }
  return "";
}

function outcomeLabel(outcome: { kind: string }): string {
  switch (outcome.kind) {
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
    default:
      return outcome.kind;
  }
}

// 回写开关在每个实例上；只有被显式关联过（links）的 Paseo 会话才会回写，避免误伤。
export function registerLifecycle(
  server: PluginServerContext,
  settings: PluginSettings<typeof MulticaSettingsSchema>,
): void {
  server.on("agent.turn_ended", async (event) => {
    const link = getLink(event.agent.id);
    if (!link) return;

    const state = await settings.read();
    if (state.status !== "ready") return;
    const inst = resolveInstances(state.values).find((i) => i.id === link.instanceId);
    if (!inst || !inst.writeBack || !inst.token) return;

    const client = new MulticaClient(inst);
    const body = latestText(event.timeline);
    const lines = [`**Paseo 会话结束**：${outcomeLabel(event.outcome)}`];
    if (event.agent.title) lines.unshift(`Paseo 会话《${event.agent.title}》`);
    if (body) lines.push("", body);

    await client.comment(link.issueId, lines.join("\n"));
  });
}