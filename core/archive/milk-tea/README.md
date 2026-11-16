# 奶茶热销中（S4，2026110100 族）— 已退役归档

**归档日期**：2026-11-16
**退役原因**：活动营业期 2026-10-15 ~ 11-14，结算期 11-15 ~ 11-16，最终截止
`endTime = 1794844799`（2026-11-16 23:59:59）；官方规则要求结算期结束前完成兑换。

## 这里有什么

| 文件 | 原位置 | 说明 |
|---|---|---|
| `services/milk-tea-activity.js` | `core/src/services/` | 只读快照 + 显式查询 + 面板手动操作（1401 行） |
| `controllers/admin-milk-tea-activity-routes.js` | `core/src/controllers/` | `/api/activity/milk-tea`、`/query`、`/operate` |
| `gameConfig/MilkTeaActivity.json` | `core/src/gameConfig/` | 操作校验所需最小固定约束（菜谱/店铺等级/雇佣时长） |
| `proto/milk-tea.proto` | `core/src/proto/` | `gamepb.milkteapb` 独立命名空间 |
| `web/MilkTeaActivityPanel.vue` | `web/src/components/activity/` | 活动面板（1111 行） |
| `web/activity-store-milkTea.ts` | `web/src/stores/activity.ts` 第 614 行起 | 活动 store、下架门控、一键领取、MilkTea 类型（625 行） |
| `test/*.test.js` | `core/test/` | 11 个奶茶测试 + 2 个依赖奶茶 store 的活动测试 |

`core/eslint.config.mjs` 已把 `archive/**` 加入 ignores：归档代码保留退役时的原样，
不参与构建，也不被现行代码风格回溯修改。

## 同时切断的运行时引用

- `core/src/core/worker.js` — `getMilkTeaActivity` / `queryMilkTeaActivity` / `operateMilkTea` 三个 case
- `core/src/runtime/data-provider.js` — 三个转发
- `core/src/services/activity.js` — `milkTeaActivity` require、奶茶根专用解码分支、`...milkTeaActivity` 展开
- `core/src/utils/proto.js` — `milk-tea.proto` 加载与三个 `MilkTea*` 解析类型
- `core/src/controllers/admin-activity-routes.js` — 路由注册
- `web/src/views/Activity.vue` — 面板挂载与全部奶茶交互（改为「暂无进行中的活动」+ admin 活动分析入口）
- `core/test/worker-api-error.test.js` — 第 4 个测试（业务码跨完整消息链，以奶茶为载体）

**保留未动**：`EventItems.json` 里的 `1041 奶茶券` / `1042 宣传喇叭` 物品定义。
背包里可能还有存量，删掉会导致物品变成未识别。

## ⚠️ 恢复前必须修的已知缺陷

`gameConfig/MilkTeaActivity.json` 的 `announceSettle.startAt` 写成了 **1795795200**
（2026-11-28），但官方公告与注释都是 **2026-11-15 00:00**（正确值 **1794672000**），
偏差 13 天。

后果：`timingOf()` 在 11-15 ~ 11-16 结算期内仍判 `phase = 'open'`，
营业类操作（卖奶茶、雇佣、互动、活动种子购买）不会被拦截，会向已停止营业的
服务端发无效请求。实测 2026-11-16 12:02 仍返回 `phase: "open"`。

恢复时二选一：
1. 把值改成 `1794672000`；
2. 或改为从官方公告正文解析，不再硬编码。

## 恢复步骤

1. 把本目录文件 `git mv` 回原位置。
2. `web/activity-store-milkTea.ts` 追加回 `web/src/stores/activity.ts` 末尾
   （`ClaimAllItemResult` 仍在原文件，不要重复定义）。
3. 按上表恢复六处运行时引用。
4. 先修 `announceSettle.startAt`。
5. 恢复 11 个测试，`worker-api-error` 第 4 个测试按当前活动重新适配。
6. 确认服务端 `ActivityService.List` 重新下发根节点 `2026110100`
   —— 代码的第一道闸 `assertMilkTeaRootListed` 只认这个。