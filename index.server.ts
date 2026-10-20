import type { PluginServerContext } from "@getpaseo/plugin/server";
import { multicaSettings } from "./shared/model";
import { registerHandlers } from "./server/handlers";
import { registerLifecycle } from "./server/lifecycle";
import { registerProvisionHandlers, repairRuntimeWrapper } from "./server/provision";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(multicaSettings);
  registerHandlers(server, settings);
  registerLifecycle(server, settings);
  registerProvisionHandlers(server, settings);

  // 插件升级后安装目录可能变化：启动时自愈 wrapper（仅当它已存在）。
  void repairRuntimeWrapper(settings).catch((error) => {
    process.stderr.write(`[paseo-multica] wrapper 自愈失败: ${String(error)}\n`);
  });

  return () => {};
}