# 牧场（MC / Pasture）玩法 — 81 包分析结论

**发现于**：微信小游戏包 81（客户端 `1.17.0.3`，目录 mtime 2026-11-16 11:28）
**分析日期**：2026-11-16
**解包产物**：`D:\tmp\wx81`（129 文件；80 包 109 文件）

## 一句话结论

**牧场是当前微信小游戏 `wx5306c5978fdb76e4` 的一个分包（不是独立小程序）。
它已进入上线/灰度流程**（主游戏设置界面已有「显示牧场建筑气泡」「一键收获天工作物」
两个 `mc*` 开关），**但数据仍是客户端 Mock、服务端没有任何协议**，
所以本项目当前不需要（也无法）做自动化适配。

> 2026-11-16 更正：早期写的「入口未接」不成立，判断方法有缺陷（见第二节）；
> 网上流传的截图是真的美术，但来自比 81 更早开放的、更完整的版本（见第三节）。

## 一、它是分包，不是新小程序

`__APP__/app-config.json`（微信小程序的 `game.json` 等价物）里明确登记：

```json
"subPackages":[
  {"name":"internal","root":"/subpackages/internal/"},
  {"name":"main","root":"/subpackages/main/"},
  {"name":"mcboot","root":"/subpackages/mcboot/"},        // ← 牧场
  {"name":"__ccWasmAssetSubpkg__","root":"/cocos-js/assets/"},
  {"name":"__ccWasmChunkSubpkg__","root":"/cocos-js/chunks/"}
],
"parallelPreloadSubpackages":[...,{"name":"mcboot"},...]
```

- 同一个 AppID `wx5306c5978fdb76e4`、同一份 app-config.json、同一套 TSDK
- 还进了 `parallelPreloadSubpackages`（启动时并行预下载），说明官方把它当重头戏
- 包体：`_subpackages_mcboot_.wxapkg` 2.3M / 15 个文件

## 二、入口判断的更正（2026-11-16 晚）

**早期结论「入口未接」是错的，判断方法有问题。**

我最初用 `grep mcboot|Pasture|Ranch` 扫主包与 main 子包，全部 0 次，据此推断没有入口。
但同一方法对**已在运行的农场 bundle 也返回 0**：

```
mainscene=0  extraRes=0  commonRes=0  plant=0  animal=0  petdog=0  weather=0  aiHead=0  mcRes=0  mcboot=0  internal=0  main=0
```

业务代码根本不写 bundle 名字面量（Cocos 从 `settings.assets.projectBundles` 与
资源路径推导），所以**这个 grep 无法证明「没有入口」**。

### 反而找到了牧场已经集成进主游戏的证据

`gamecaches/extraRes/` 下三个设置界面资源（最新一份 `17948013196100.json`，
2026-11-16 11:55 下载）同时包含「牧场」+ `mcOneClickTG` + `mcBubble`：

| 节点名 | 对应设置项文案 |
|---|---|
| `mcBubbleBtn` / `mcBubbleNode` | **显示牧场建筑气泡** |
| `mcOneClickTGBtn` / `mcOneClickTGNode` | **一键收获天工作物** |

设置界面里给牧场留了开关，说明牧场**已进入上线/灰度流程**，不是纯预埋。

### 分包加载机制（原判断保留部分）

`__APP__/game.js` 里 Cocos 的 bundle 下载器确认了分包读取路径：

```js
m[p] = "subpackages/".concat(p)          // init 时由 settings.assets.subpackages 填充
c = "subpackages/".concat(p, "/config.").concat(_,"json")   // _ = bundleVers[p]
```

`settings.ca15f.json`：

```json
"subpackages": ["internal","main","mcboot"],
"remoteBundles": [...,"mcRes",...],
"bundleVers": {"mcboot":"eded6","mcRes":"7725a"},
"preloadBundles": [{"bundle":"resources"},{"bundle":"main"}]
```

mcboot 不在 `preloadBundles`，所以仍需业务代码触发 `loadBundle('mcboot')`；
但**触发点没法用字符串 grep 定位**，只能动态观察。

## 三、流传截图是真的，但版本比 81 新

对照 `mcRes` 缓存里的美术，截图可确认为真：牧场背景图
（`1794799703727162.png`，1125×1076，瀑布+湖+草地）与截图完全一致；
UI 图集（木质面板、"回归"图标、"友"按钮）也在缓存里。

但截图里有 81 包**没有**的文案：

| 截图 | 81 包 / 当前缓存 |
|---|---|
| 返回农场 | 全缓存 **0 次**；mcRes 里是 **「回家」** |
| 一键收获 | 只在设置界面出现（`mcOneClickTG`），mcboot 代码里没有 |
| 总价值 / 待领取邮件 | 0 次 / 0 次 |

而「天工作物」在 `mcboot/game.js` 的 89 个 UI 串里**不存在** →
截图来自**比 81 更新的包**（文案 `回家`→`返回农场`，新增天工作物收获开关）。

**截图里没有地块**：该玩家等级仅 **2**（经验 230/400）、栏舍 3/3、牧草机 1 级，
属新号。地块受 `MCCellUnlockCondition` 约束（该配置表仅 208 字节，条目极少），
新号尚未解锁属于正常。

### 顺带发现：作物有稀有度分阶

「天工」与 S3 萌宠活动文案（比熊犬/投喂元气糕/待护送）同文件出现，
并在设置项里写作「一键收获**天工作物**」，说明作物按
**普通 / 稀有 / 珍品 / 天工** 分阶（同批文案还有「稀有种子系统」
「普通稀有珍品天工作物完整新资源」「琉璃宝荷」「琉璃宝莲」「琉璃宝荷黄金」）。

## 四、早期结论保留部分：数据仍是 Mock

> 以下为原「二、入口尚未接入」的内容，入口部分已被上面更正，
> 其余仍是有效证据：



| 检查项 | 结果 |
|---|---|
| 主包 `__APP__/game.js` 里 `mcboot` / `Pasture` / `Ranch` | **0 次** |
| `main` 子包 `subpackages/main/game.js` 里同上 | **0 次** |
| `loadSubpackage` / `loadBundle` 调用 | 0 次 |
| `mcboot.scene` 内容 | **空场景**：字符串表只有 `node`、`scene`，类型只有 `cc.Scene` + `cc.SceneGlobals`，无节点/相机/Canvas |

`config.eded6.json`（Cocos AssetBundle 清单）里 `paths` 只有 12 项：
1 个场景 `scene/mcboot` + 11 篇 `docs/*.md`，`packs` 为空、`native` 为空
→ 分包本身不含任何美术资源。

结论：客户端把牧场**预埋**好了（分包 + 空场景 + 完整业务脚本 + 文档 + 远程配置），
但主流程没有任何地方去加载它。这是标准的「提前铺路、入口后开」。

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

## 五、远程资源（mcRes）—— 配置表与 UI 预制体都在这儿

分包只有代码，真数据在微信缓存：

```
%APPDATA%/Tencent/xwechat/radium/users/<hash>/applet/local/wx5306c5978fdb76e4/
  usr/gamecaches/mcRes/          ← 144 个 JSON，6.5MB
```

- **57 个明文 Prefab/Scene**（CCON 格式，`d[2]` 是共享字符串表，节点名在此）
- **35 个加密配置表**（`FSpk…` 前缀的 base64 串，疑似 XXTEA；资源名明文，内容不可读）

### 35 个配置表（功能地图）

| 配置 | 大小 | 说明 |
|---|---|---|
| `MCItemInfo` | 984K | 物品全表（最大） |
| `MCTask` | 105K | 任务 |
| `MCIllustrated` | 53K | 图鉴 |
| `MCGoods` | 45K | 商品 |
| `MCFacilityConfig` | 20K | 设施 |
| `MCGuidePasture` | 18K | 牧场引导 |
| `MCAnimalConfig` | 13K | 动物 |
| `MCAnimalMutation` | 8K | **动物变异** |
| `MCRanchLevelBonus` | 3.9K | 牧场等级奖励 |
| `MCRotationShopGoods` | 3.1K | 轮换商店商品 |
| `MCEmployeeCfg` | 2K | **雇员** |
| `MCMainCityLvConfig` | 1.8K | **主城等级** |
| `MCShop` | 1.4K | 商店 |
| `MCEmployeeSkillCfg` | 1.4K | **雇员技能** |
| `MCEnv` | 1.2K | 环境 |
| `MCNpcConfig` | 1.2K | NPC |
| `MCActive` | 1.1K | 活动 |
| `MCRanchOperation` | 1K | 牧场操作 |
| `MCCanConfig` | 754 | 未定 |
| `MCItemTab` | 508 | 物品页签 |
| `MCSalaryCfg` | 502 | **工资** |
| `MCRanchLabLvConfig` | 429 | **实验室等级** |
| `MCMutantInfo` | 423 | 变异信息 |
| `MCFacilityCategory` | 381 | 设施分类 |
| `MCRotationShopShelf` | 366 | 轮换商店货架 |
| `MCFacilityShopConfig` | 359 | 设施商店 |
| `MCRanchWeightTier` | 336 | **体重分档**（匀称/超重/极重） |
| `MCNpcSpawnPoint` | 294 | NPC 刷新点 |
| `MCRanchFacilityConfig` | 260 | 牧场设施 |
| `MCGuidePastureConfig` | 235 | 引导配置 |
| `MCItemSort` | 229 | 物品排序 |
| `MCItemTrait` | 226 | **物品特性** |
| `MCCellUnlockCondition` | 208 | **地块解锁条件** |
| `MCRotationShopParams` | 171 | 轮换商店参数 |

带 ★ 的说明还有 **雇佣雇员 / 实验室 / 主城等级 / 轮换商店 / 物品特性** 等未在文档展开的系统。

### UI 预制体（14 个含字符串表的）

| 文件尾号 | 判定 | 关键节点 |
|---|---|---|
| `0327184` | **主界面** | `nodeHeadFrame` `headImg` `imgLevel` `expBar` `txtName` `txtDiamond` `txtGold` `btnExit` |
| `0332493` | **好友操作面板** | `operateIcon_steal/help/wife` `newPao*` `redNode` `imgNew` |
| `0332490` | 好友/社群切换 | `groupBtn` `friendBtn` `switchGroupNode` |
| `3507110` | **回访/求助列表** | `nudgeBtn`（戳一下）`visitBtn`（回访）`nameplateBg/Decoration` `scrollViewEx` |
| `0331788` | 商品格 | `txtPrice` `txtLock` `txtType` `imgHei`（已拥有） |
| `4114215` | 特效预制体 | `buttonShakeAnimation` `headShakeAnimation` |
| `0322481` | TileMap | `_tmxFile` `tileMap` |
| 其余 7 个 | 通用组件/地块 | — |

主界面明文文案：**商城 / 仓库 / 商店 / 图鉴 / 回家**；
回访列表文案：**当前暂无满足条件的好友 / 回访 / 打招呼 / 在你家 / 帮你照顾了农场4次 / 一分钟前**。

## 六、玩法清单（10 篇官方文档 + 配置表交叉）

### 核心循环（牧场有自己的地块，与农场 24 块地互不相干）
进牧场 → 自动铺 80% 地块 → 点地块开种植面板 → 选/拖种子 → 逐阶段生长
→ 成熟出可摘特效 → 点击收获 → 枯萎 → 铲除清空。

`PastureWorld` 是独立世界（`SceneType.Pasture`），自带 TileMap 和地块，
与农场主包 `script/game/farm/` **并行、互不干扰**（文档第 1 节原文）。

#### 三种作物（代码硬编码，非配置驱动）

`mcboot/game.js` 里有完整的 Mock 作物表 `z = [B, 小麦, 番茄]`：

| 作物 | 阶段链 | 阶段数 |
|---|---|---|
| 第 1 种（名字取自字符串池索引，未解出；`"牧草"` 在代码中仅作 fallback 默认名） | 种子 → 发芽 → 幼苗 → 成熟 | 4 |
| **小麦** | 种子 → 发芽 → **抽穗** → 成熟 | 4 |
| **番茄** | 种子 → 发芽 → **小叶** → **开花** → 成熟 | 5 |

导出接口（`System` 注册的 mock 模块）：

```js
buildMockPlantConfig(plantId, name, cropAsset)  // 有 cropAsset 就直接造，否则回落默认
getMCPlantSpritePath(name, stage)               // `${base}/${name}_${stage}${ext}`
getMockPlantConfig
randomMockPlantConfig()                         // floor(random()*z.length) 随机取一种
```

**关键**：`randomMockPlantConfig` 随机挑作物，说明现在是 Mock 行为（真实玩法应由玩家选种子）。
35 个配置表里**没有** MCCrop / MCPlant / MCSeed —— 作物时长与产物尚无正式配置，
文档第 9 节把「作物构造 & 阶段时长」列为待接服项之一。

#### 为什么牧场要种地

补给链：**种作物 → 收牧草/饲料 → 投入牧草机 → 喂动物 → 动物（幼崽→成长→生产）产出**（如鸡蛋）。
牧草机文档写明「从仓库消耗牧草道具」，仓库无草时按钮变「去商店」——
即牧草既是种出来的，也能直接买。

### 八大模块

1. **栏舍动物交互** —— 点窝/棚镜头推近；点动物描边选中 + 头顶详情气泡；
   底部操作条每页 5 条（罐头桶 / 出售 / 放蚊子 / 幼崽入栏）；从操作条拖出图标
   划过栏舍连续触发（400ms 节流）；一键收获 / 生产 / 偷取 / 清理；
   副产物架最多 5 槽 + more；牧草机 HUD；收获篮子；栏舍升级。
2. **牧场仓库** —— 页签结构由服务端下发；容量 `curNum/maxNum`；单选查看详情/单价；
   产物页签批量出售；单件出售弹窗；使用道具；锁定/解锁；新道具红点；空态跳商店。
3. **牧场商店** —— 幼崽商店 / 饲料商店；货架显示窝棚类型、品阶、限购、售罄；
   `auto_add`（幼崽→窝/棚、饲料→牧草机）；住满仍可买 1 只进仓库；金币不足跳仓库出售。
4. **牧草机** —— 自家投草 / 访客赠送（无草时用金币）；容量进度条；
   剩余可用时间（`-1` 充足、`0` 永不耗尽、`>0` 倒计时）；升级；建筑气泡告警。
5. **建筑升级 / 地块解锁 / 加速** —— 三段式：发起 → 可选加速 → 完成确认；
   场景倒计时条 + 竣工气泡 + `btn_speedup`。
6. **建筑与动物气泡** —— 8 种建筑状态：竣工✓（最高优先级）/ 订单可交 / 牧草耗尽 /
   牧草偏低 / 可收获 / 可偷取（客态）/ 可交付 / 可清理；
   2 种动物状态：可收获 / 交付中（带倒计时）。
7. **任务系统** —— 只用 `task_type` 4=家园成长 / 5=家园日常 / 6=家园支线，
   1-3（农场成长/日常/支线）被 RPC 过滤；主界面任务条 + 面板；前往/领取；
   分享翻倍；完成飘字；日常活跃点（无活跃宝箱）。
8. **建筑编辑与收纳** —— 编辑模式 → 建筑背包（生产/装饰 Tab）→ 取出放置 →
   拖拽调整 → 保存；移动；收纳回背包；取消还原；编辑时全显网格 + 绿/红占位预览。

### 动物
- 品种：**考拉、豪猪、水牛、骆驼、蜜薯**（另有狗，可改名）
- 阶段：**幼崽 → 成长 → 成年**；状态：缺草、生产、产出
- **体重分档**：匀称 / 超重 / 极重（对应主界面体重排行图 `bg_item_mc_weight_rank.png`）
- 产物：鸡蛋等；支持放生、赠送
- **变异体系**：`MCAnimalMutation` + `MCMutantInfo`，延续农场变异玩法

## 七、代码里没有 RPC（文档写的是「接服设计方案」）

文档详细写了 `GetBag` / `GetBagTab` / `Sell` / `Use` / `LockItems` / `CannelNew` /
`BuyGoods` / `ShopProfiles` / `AddFeed` 等 RPC，**但 mcboot/game.js 里这些字符串一个都没有**：

```
GetBag 0 | GetBagTab 0 | BuyGoods 0 | AddFeed 0 | LockItems 0
CannelNew 0 | ShopProfiles 0 | TaskGetReward 0 | OpGetGroup 0
sendMsgAsync 0 | callServer 0 | WebSocket 0 | socket 0
```

文档第 9 节自己也承认：「当前所有数据均为客户端 Mock」，并列出 6 处待接服项
（地块、种子背包、作物时长、种植/收获/铲除）。

**含义**：文档描述的是目标架构，代码是 Mock 实现。将来真接服时，
这些 RPC 名就是现成的适配清单。

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

# 1. 分包声明是否还在
cat /d/tmp/wxNN/__APP__/app-config.json | tr ',' '
' | grep -i mcboot

# 2. 入口是否接了（关键！出现非 0 就要重新评估）
grep -c mcboot /d/tmp/wxNN/__APP__/game.js
grep -c mcboot /d/tmp/wxNN/_subpackages_main_/subpackages/main/game.js

# 3. 是否有牧场网络代码
grep -cE "rpc|sendMsg|SendMsg|WebSocket|socket|GetBag|BuyGoods|AddFeed"   /d/tmp/wxNN/_subpackages_mcboot_/subpackages/mcboot/game.js

# 4. 官方文档是否更新（数量变了说明加了模块）
ls /d/tmp/wxNN/_subpackages_mcboot_/subpackages/mcboot/import*/

# 5. 远程配置表是否更新
ls "$APPDATA/Tencent/xwechat/radium/users/<hash>/applet/local/wx5306c5978fdb76e4/usr/gamecaches/mcRes" | wc -l

# 6. 项目 proto 里有没有牧场 service
grep -ohE 'service [A-Za-z]+' core/src/proto/*.proto
```

### 提取配置表资源名（内容加密但名字明文）

```js
const d = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const inst of (d[5] || []))
  for (const v of inst)
    if (typeof v === 'string' && /^MC[A-Z]/.test(v)) console.log(v)
```

### 提取 Prefab 节点名（`d[2]` 是共享字符串表）

```js
const d = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log((d[2] || []).filter(x => typeof x === 'string').join(' | '))
```

一旦 mcboot 内出现真实 RPC，或项目 proto 新增牧场 service，才需要做自动化适配。