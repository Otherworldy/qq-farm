# 牧场（MC / Pasture）玩法 — 81 包分析结论

**发现于**：微信小游戏包 81（客户端 `1.17.0.3`，目录 mtime 2026-11-16 11:28）
**分析日期**：2026-11-16
**解包产物**：`D:\tmp\wx81`（129 文件；80 包 109 文件）

## 一句话结论

**牧场是纯客户端 Mock 玩法，服务端没有任何协议。本项目当前不需要（也无法）做自动化适配。**

## 证据

| 检查项 | 结果 |
|---|---|
| `mcboot/game.js` 里的 `rpc` / `sendMsg` / `SendMsg` / `Sync` | **0 次** |
| `mcboot/game.js` 里的 `MC_REQUEST_*` | 0 次（文档提到的常量已不在代码里） |
| 主包 `game.js` 里的 `Pasture` / `Ranch` / `mcboot` | **0 次** |
| 项目 `core/src/proto/*.proto` 的 service | 7 个，无牧场（Activity/Career/Illustrated/Mall/MysteryShop/RedPacket/Visit） |
| 官方开发文档第 9 节 | 「当前所有数据均为**客户端 Mock**」 |

官方文档原文（`牧场模块开发指南.md` §9）列出的 6 处 Mock：

| 临时 mock | 位置 | 正式方向 |
|---|---|---|
| 自动生成 80% 地块 | `PastureSceneLoginInitSystem` 监听 `TileMapReady` → `spawnDefaultLands` | 服务器回包地块数据 |
| 地块数据构造 | `MCFarmLandMockHelper.buildFillLandData` | 服务器地块列表 |
| 种子背包 | `MCFarmMockData.getSeeds` / `consume` | `ItemManager` 真实背包 |
| 作物构造 & 阶段时长 | `MCFarmMockData.buildPlantMock` | 服务器种植数据 + 配置真实时长 |
| 种植/收获/铲除 | 本地 `createPlant`/`harvestPlant`/`erasePlant` 直接改数据 | 走服务器请求-回包 |

## 官方开发文档被打进了包（意外收获）

`_subpackages_mcboot_/subpackages/mcboot/import/` 下 9 个 CCON JSON 含 **10 篇 markdown
文档**，共约 185K 字。提取方式：

```js
// d[3] 是 cc.TextAsset 类定义；d[5] 是实例数组，每条 [typeIdx, name, text]
const d = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const [, name, body] of (d[5] || [])) {
  if (typeof body === 'string' && body.length > 50) writeFileSync(name + '.md', body)
}
```

已导出到 `D:\tmp\mc-docs\`：

| 文档 | 字数 | 价值 |
|---|---|---|
| 栏舍动物交互.md | 21.7K | 面板接线、操作条、一键收获/生产/偷取/清理 |
| 牧场仓库.md | 20.8K | `GetBag` / `Sell` / `Use`、页签红点 |
| 牧场商店.md | 20.3K | 幼崽/饲料商店、`BuyGoods`、auto_add |
| 建筑升级地块解锁与加速.md | 19.6K | 升级/解锁倒计时、`TIME_SPEEDUP` |
| 牧场牧草机.md | 18.8K | 全局牧草存储、`AddFeed`、栏舍 HUD |
| 建筑与动物气泡.md | 18.7K | UnitBubble 渲染、状态气泡 |
| 牧场任务系统.md | 16.9K | 成长/日常任务、领奖、Notify 推送 |
| 建筑编辑与收纳.md | 16.0K | 建筑背包、放置/移动、编辑会话 |
| 牧场模块开发指南.md | 15.5K | 架构、ECS 分层、种植闭环、接服约定、GM 工具 |
| README.md | 1.3K | 文档索引与代码路径 |

**注意**：文档里的 `GetBag` / `Sell` / `BuyGoods` / `AddFeed` 等是**客户端方法名或本地事件**，
不是 proto RPC —— 上表的证据已确认 mcboot 内零网络代码。

## 玩法内容（从新增中文串 3823 条归纳）

- **动物**：考拉、豪猪、水牛、骆驼、蜜薯（狗名可改）；状态：幼崽 / 成长 / 成年 / 缺草
- **体重分档**：匀称 / 超重 / 极重 —— 对应新增图片 `bg_item_mc_weight_rank.png`（体重排行）
- **作物**：牧草、小麦、番茄（有「抽穗」阶段）
- **建筑**：栏舍、诊所、喷泉；支持升级、地块解锁、编辑收纳
- **交互**：放生、照料、赠送、一键收获、偷取、整栏操作
- **商店**：金券、限购

## 架构（供将来接服时参考）

```
PastureWorld (script/world/PastureWorld.ts)
  └─ Scene (SceneType.Pasture)
       └─ MCBoot 场景根组件
            ├─ TileMapMgrComp  瓦片/占位网格
            ├─ Unit 系统        创建/拖拽/占位
            ├─ PastureSceneLoginInit  登录初始化
            └─ MCFarmLandsCom  ECS 玩法层
                 ├─ MCFarmLandViewCom      地块视图
                 ├─ MCFarmLandInteractCom  点击分派
                 ├─ MCPlantInteractiveComp 种植面板
                 └─ MCPlant / MCFarmPlantViewCom  作物
```

接后端要点（文档 §9 原文）：把 `MCFarmLandsCom` 对 `MC_REQUEST_*` 的处理由
「直接改数据」改为「发协议 → 回包后改数据 + 派发 `*_COMPLETED`」。事件驱动已解耦，
**视图层无需改动**。

## 其他 81 包变化（与牧场无关）

- 新增子包 `_subpackages_mcboot_.wxapkg`（2.3M，15 文件）
- 删除 `logoNc`/`logoMc` 加载画面节点（`0b6aaa439.ad141.json`）—— 奶茶 logo 随活动下架
- 中文串 **80: 427 → 81: 3823**；排除 mcboot 后主包仅新增 58 条，且全部是牧场相关内容
  （动物名 + 动物轮廓发光 shader 参数）
- 移除 3 个词：大象 / 海狗 / 猩猩（动物阵容调整）
- 「奶茶」在 81 包内只剩 1 处，是装扮分类 `24:"奶茶"`，与活动无关

## 下次怎么查

```bash
# 解包
node core/scripts/unpack-wxapkg.js --package "<微信包目录>/<版本>" --out D:/tmp/wxNN

# 是否有牧场网络代码（有输出就要重新评估适配）
grep -cE "rpc|sendMsg|SendMsg|Sync" /d/tmp/wxNN/_subpackages_mcboot_/subpackages/mcboot/game.js

# 官方文档是否更新
ls /d/tmp/wxNN/_subpackages_mcboot_/subpackages/mcboot/import/

# 项目 proto 里有没有牧场 service
grep -ohE 'service [A-Za-z]+' core/src/proto/*.proto
```

一旦 mcboot 内出现真实 RPC，或项目 proto 新增牧场 service，才需要做自动化适配。