import { defineAttachmentSource } from "@getpaseo/plugin";
import { issuesSearchRpc } from "./rpc";

// 把 Multica 卡片作为可搜索的外部资源附进 Paseo 输入框。
export const multicaIssueSource = defineAttachmentSource({
  id: "multica-issue",
  title: "Multica 卡片",
  icon: "SquareKanban",
  pickerTitle: "附加 Multica 卡片",
  searchPlaceholder: "按标识或标题搜索卡片",
  search: issuesSearchRpc,
});