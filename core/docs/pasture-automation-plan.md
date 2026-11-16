# 牧场自动化适配方案（规划）

**触发**：2026-11-16 牧场正式开放，用户账号已可进入
**前置文档**：`pasture-mc-analysis.md`（牧场是什么、美术/配置/玩法面）

---

## 一、结论先行

**能做，且比预想的简单，但有一个硬前置：先抓一次包。**

早期结论「牧场零协议、纯 Mock」是**错的**。修正后的真相：

| 层 | 事实 |
|---|---|
| 数据模型 | mcboot 里定义了 **539 个 protobuf 消息、1937 个字段**，字段名全明文 |
| 请求构造 | 有完整请求对象（`{ranch_inst_ids, op, animals, shelves}` 等），**20+ 个调用点** |
| 传输 | mcboot **不做传输**，请求交给主包注入的网络模块（外部 dep `238`） |
| 连接 | 与农场**同一条 WS、同一套 TSDK/ACE、同一个 `GateMessage` 外壳** |
| RPC 名 | 被 TSDK 字节码 VM 加密，静态拿不到（`_Аce_7716`） |

**关键推论**：既然共用同一条 WS 和同一套帧格式，那么**农场现有的网络层、TSDK、proto 加载、调度骨架全部可以直接复用**，牧场只需要补：协议定义 + 业务编排 + 面板。工作量约等于「再写一个 farming-orchestrator」，而不是「重做一个客户端」。

---

## 二、已经拿到的协议面（静态可得）

字段名是明文，这部分**不需要抓包也能先写 proto**。

### 2.1 核心数据模型

```
RanchInfo        1 ranch_inst_id  2 capacity  3 animal_count  4 animals[]
                 5 grass  6 husbandry_type  7 shelves[]  8 hazards[]

AnimalInst       1 ranch_inst_id  2 slot_index  3 animal_inst_id  4 animal_id
                 5 stage  6 produce_count  7 can_harvest  10 grow_ready_at_ms
                 11 produce_ready_at_ms  12 grass_blocked  14 infant_ready_at_ms
                 15 producing  16 can_deliver  17 delivering_until_ms
                 18 can_feed  19 limited_can_used  20 can_donate
                 21 expected_harvest_exp  22 expected_harvest_sells[]
                 23 expected_produce_exp  24 expected_produce_sells[]
                 25 mature_ready_at_ms  30 mutation

AnimalMutation   1 mutation_type  2 source  3 weight_display_x10  4 scale_bp
                 5 weight_final_x10  6 tier  7 became_at_ms  8 strokable  9 stroked_gids[]

Shelf            1 slot_index  2 lots[]  3 total_remain  4 can_collect  5 can_steal
ShelfLot         1 item_id  2 base_num  3 remain_num  4 stolen_num  5 animal_id
                 6 can_steal  7 stealers[]

Grass            1 amount  2 empty_at_ms
Hazard           1 hazard_id  2 owner  3 hazard_type

RanchOp (req)    2 ranch_inst_ids[]  3 op  4 animals[]  5 shelves[]   ← op 决定带哪些
OpQuota          1 op_id  2 times_limit  3 used_times  4 remaining_times
```

### 2.2 与农场模型的语义对应（这是自动化的落脚点）

| 农场 `LandInfo` / `PlantInfo` | 牧场 `RanchInfo` / `AnimalInst` | 用途 |
|---|---|---|
| `lands[]` | `ranches[]` | 巡田/巡栏的入口 |
| `getCurrentPhase()==MATURE` | `can_harvest == true` | 可收获 |
| `phases[last].begin_time` | `produce_ready_at_ms` / `mature_ready_at_ms` | **精确抢收墙钟** |
| `dry_num > 0`（需水） | `can_feed == true` / `grass_blocked` | 需投喂 |
| `weed_owners` / `insect_owners` | `hazards[]` | 需要清理 |
| `empty` 空地 | `capacity - animal_count` | 补栏 |
| `isOccupiedSlaveLand`（2x2 从属） | 无对应（牧场是槽位制） | 简化 |
| 好友 `stealable` | `Shelf.lots[].can_steal` | 偷产物 |

**结论**：`farm-land-analyzer.js` 的分析器写法、`farming-orchestrator.js` 的「收获→务农→种植→升级」五段式、以及**成熟墙钟表**机制，结构上可以整体照搬，只换字段来源。

### 2.3 已知请求（参数结构，方法名待抓包补）

```
{ranch_inst_ids}                                     拉取/刷新牧场
{host_gid, targets}                                  好友牧场
{ranch_inst_id, host_gid, hazard_ids}                 清灾害
{ranch_inst_id, host_gid, op_id, count}               某种操作配额
{ranch_inst_ids, op, animals, shelves}                ★核心操作（RanchOp）
{op_ids}                                             查配额
{host_gid, hazard_ids}
{ranch_inst_id, capacity}                            扩栏
{item_id, count}                                     买动物/买草
{add_count, use_gold, host_gid}                      加油草
{bucket_type}                                        草料桶
```

`op` 枚举值域 `0..4`（-1 无效）。从调用点可推：`op=1` 带 `shelves`、`op=3/4` 带 `animals`、`op=2` 两者都空 → 对应「收货架 / 喂食 / 清理 / 收获」一类，**但具体映射必须抓包确认，不能猜**。

---

## 三、逐层改造清单

### ✅ 3.1 零改动复用（不要碰）

| 模块 | 说明 |
|---|---|
| `utils/network.js` | WS 连接、`GateMessage` 帧编解码、TSDK 加密、心跳、重连。**唯一需要加的是通知分派分支** |
| `utils/tsdk-runtime.js`、`utils/crypto-wasm.js`、`services/ace-service.js`、`utils/gateway-token.js` | 同一 AppID、同一 TSDK，牧场完全共用 |
| `services/scheduler.js` | 命名空间定时器 |
| `services/daily-events.js` | 事件流水，`type` 自定义即可 |
| `services/json-db.js`、`config/runtime-paths.js` | 持久化 |
| `runtime/worker-manager.js`、`runtime/data-provider.js`、`runtime/runtime-engine.js` | worker 通道骨架 |
| `utils/idle-protection.js`、`utils/pause-until.js`、`services/rate-limiter.js`、`services/privacy-guard.js` | 护栏 |

> `network.js` / `tsdk-runtime.js` / `scheduler.js` 里那些注释（启动竞态、踢下线、ACE 暂停、预算不计失败）都是线上事故换来的，**改一行都要有理由**。

### 🔧 3.2 小幅修改（加分支/加白名单/加配置项）

| 文件 | 要改什么 | 规模 |
|---|---|---|
| `utils/proto.js` | `performLoad` 的 `newRoot.load([...])` 加 `pasturepb.proto`；`resolved` 里挂一批新类型 | +1 行 +N 条 |
| `services/request-governor.js` | `WHITELIST` / `WATCHMODE_METHODS` 加牧场 service.method；**预算要和农场分池**（当前 80/min 总，30/min 单方法，牧场进来要重新分配） | 中等 |
| `models/store.js` | `DEFAULT_AUTOMATION` 加牧场开关组；`cloneAccountConfig` 同步（**否则多账号共享引用**） | 中等 |
| `core/worker.js` | 加 `nextPastureRunAt`；`runUnifiedTick` 里插一段与 `runFarmTick` 同级；`handleApiCall` 加 case | 中等 |
| `runtime/data-provider.js` | 映射表加 `getPasture` / `doPastureOp` 等 | 小 |
| `controllers/admin.js` | 注册 `admin-pasture-routes` | 1 行 |
| `network.js` | `handleNotify` 加牧场通知分支（`unknownNotifyTypes` 会先把它记下来，可以先用这个侦察） | 小 |
| `web/src/router/menu.ts` | 加菜单项 | 1 行 |

### 🆕 3.3 需要新增

| 文件 | 职责 | 参照 |
|---|---|---|
| `core/src/proto/pasturepb.proto` | 牧场全部消息（可先用第二节的明文字段起草，抓包后校准） | `plantpb.proto` |
| `core/src/services/pasture-api.js` | RPC 收口，照抄 `farm-api.js` 的三行封装模式 | `farm-api.js`（195 行） |
| `core/src/services/pasture-analyzer.js` | 纯函数：`ranches[]` → 可收获/需喂/需清理/空栏/可偷/成熟墙钟 | `farm-land-analyzer.js`（670 行） |
| `core/src/services/pasture-orchestrator.js` | 编排：收货架 → 收产物 → 喂草 → 清灾害 → 补栏 → 升级 | `farming-orchestrator.js`（691 行） |
| `core/src/services/pasture-visit.js` | 好友牧场：进 → 分析 → 偷产物/帮喂 → 出 | `friend-visit.js`（1493 行，只需 Enter→分析→操作→Leave 骨架） |
| `core/src/gameConfig/PastureAnimals.json` 等 | 动物/设施/饲料配置 | 数据来源见第五节 |
| `core/src/controllers/admin-pasture-routes.js` | Express 路由 | `admin-farm-resource-routes.js` |
| `web/src/views/Pasture.vue` + `stores/pasture.ts` + `components/PasturePanel.vue` | 面板 | `FarmPanel.vue` + `stores/farm.ts` |

### 🚫 3.4 牧场没有对应物的（不要硬搬）

- 施肥体系（`farm-fertilizer.js`、`fertilizer-watch.js`）— 牧场用「投喂草料」，语义不同
- 2x2 主从地块 — 牧场是槽位制
- 种植策略（`planting-service.js` 1250 行）— 作物换动物后策略维度不同（稀有度/成长周期/产出价值）

---

## 四、硬前置：拿到协议名

### 4.1 为什么必须抓包

RPC 方法名、proto 消息名、枚举成员名全部被 `globalThis._Аce_7716` 加密（纯 JS 字节码 VM）。
静态尝试过：函数体已完整提取（11KB），VM 已能在 Node 装载，但 payload 需要真实的模块运行时环境，脱离游戏上下文会进死循环。

**结论**：静态逆向成本远高于抓一次包，**不划算**。

### 4.2 抓包为什么一定成功

`GateMessage` 的外壳是明文：

```protobuf
message Meta {
  string service_name = ...;   ← 明文
  string method_name  = ...;   ← 明文
  ...
}
```

**只有 `body` 被 TSDK 加密**，而项目已经有 TSDK WASM，`inspect:protocol --decrypt-requests` 能直接解。

### 4.3 现成工具

```bash
npm run inspect:protocol -- <牧场抓包.har> --decrypt-requests --shape
npm run inspect:protocol -- <har> --service Ranch --direction request
npm run inspect:protocol -- <har> --method RanchOp --pretty
```

支持 `_webSocketMessages`（WS 帧），支持按 service/method 过滤，支持 wire 结构摘要。

### 4.4 需要抓什么动作

按价值排序，**做一遍就能覆盖全部自动化所需**：

| 场景 | 能确定的协议 |
|---|---|
| 打开牧场主界面 | 拉取 `RanchInfo` 的 service/method + 完整回包结构 |
| 收割一次货架 | `op` 里「收货架」的值 |
| 收一只动物的产物 | `op` 里「收产物」的值 |
| 给栏舍添加牧草 | `op` 里「喂食」的值 + 草料扣减 |
| 清理一个灾害（虫/杂草） | 灾害操作的方法 + `hazard_type` 语义 |
| 买一只动物并放入栏舍 | 补栏链路 + `animal_id` 从哪来 |
| 进入好友牧场偷一次 | 好友牧场链路 + `Shelf.can_steal` 的取值 |
| 刷新一次牧场 | 是否有增量/通知推送（`PastureNotify`） |

---

## 五、数据来源问题

自动化要算「什么时候收最划算」「该养什么」，需要配置数据：

| 数据 | 状态 | 方案 |
|---|---|---|
| 动物 ID / 名称 / 成长时长 / 产出 | 35 张 `MC*` 配置表，**加密**（`FSpk…`） | 优先从协议回包拿（`AnimalInst` 已有 `expected_harvest_exp` / `expected_produce_sells`）；回包不够再解表 |
| 饲料/牧草单价 | `MCGoods`（加密） | 从商店 RPC 回包拿 |
| 设施/升级消耗 | `MCFacilityConfig`（加密） | 同上 |
| 变异/重量分级 | `AnimalMutation` 已在协议里 | 直接用 |

**重要**：`AnimalInst` 自带 `expected_*` 期望收益字段，这意味着**「该收哪个」可以直接从回包算，不依赖配置表** —— 这比农场的本地选种策略还简单。

配置表解密（`FSpk` 前缀，疑似 XXTEA）可以留到后面，不阻塞主线。

---

## 六、分阶段实施

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **0** | 抓一次牧场 HAR，跑 `inspect:protocol` 产出协议清单 | **需要用户操作** | 拿到 service/method/proto |
| **1** | `pasturepb.proto` + `pasture-api.js` + 只读拉取 | 阶段 0 | 能在面板看到牧场状态（栏舍/动物/草/货架/灾害） |
| **2** | `pasture-analyzer.js` + 自家自动化（收→喂→清→补） | 阶段 1 | 挂机一晚，无人工干预且产物正常入库 |
| **3** | 好友牧场（偷产物/帮喂）+ 成熟墙钟调度 | 阶段 2 | 与农场偷菜同等的定时精度 |
| **4** | 面板完善（地块网格、倒计时、开关分组）、统计 | 阶段 2 | 与 `FarmPanel` 同等可读性 |

阶段 1 和阶段 2 之间是**主要工作量**（约等于重写一个 `farming-orchestrator`，但不含施肥/2x2/种植策略，实际约为其 60%）。

---

## 七、风险与护栏

1. **灰度功能，接口会变**。牧场刚开放，`op` 枚举、字段都可能调整。必须保留「未知字段不 crash」的容错（`farm-land-analyzer.js` 的脏数据容错写法要照抄）。
2. **请求预算**。当前 `request-governor` 是 80/min 总池、30/min 单方法。牧场接进来后要和农场**分池**，否则两边互相挤压。这是阶段 2 必须先解决的。
3. **不猜 proto**。字段名和 `op` 值必须有抓包依据；猜错的代价是请求被服务端拒绝甚至风控，和 `故友重逢` 那个决定一致。
4. **ACE 上报暂停逻辑**。`worker.js` 里「空闲 > 60s 暂停 ACE 上报」的机制，牧场 tick 也要遵守，否则会增加无谓的风控面。
5. **和农场的让路关系**。农场已有「偷菜到点则让路」的优先级。牧场 tick 加入后要重新排优先级，建议：自家收获 always 最高（农场和牧场同级），其次好友偷取，最后日常。

---

## 八、下一步动作

**唯一阻塞项是阶段 0**：需要一份牧场的抓包。

拿到之后，`inspect:protocol` 能直接吐出 service/method/字段结构，我就可以开始写 `pasturepb.proto` 和 `pasture-api.js`。

在此之前可以并行做的零风险准备（不依赖协议）：
- `models/store.js` 加牧场开关组（纯配置，写完不影响运行）
- `web/src/router/menu.ts` 加菜单占位
- 把第二节的明文字段先写成 `pasturepb.proto` 草稿（抓包后校准）
---

# 附：2026-11-16 抓包实测结果（阶段 0 完成）

> 本节是抓包后的**实测数据**，覆盖上面第 4 节的假设。
> 抓包方式、工具链和复现步骤见文末。

## A. 协议面已完全确认

牧场 = **`gamepb.animalpb`**（AnimalService + RanchService）+ **`gamepb.homesteadpb`**
（HomesteadService + FeedMachineService）。已写进
`core/src/proto/pasturepb.proto` 和 `core/src/proto/homesteadpb.proto`，
并用真实回包逐条验证通过。

### 10 个 RPC（含抓到的参数）

| 方法 | 请求 | 响应 | 自动化用途 |
|---|---|---|---|
| `AnimalService.GetRanchDetail` | `2: ranch_inst_ids[]`（空=自己） | `RanchInfo` | 巡栏 |
| `AnimalService.HarvestRanch` | `2: ranch_inst_ids[]` `3: harvest_type=1` | `RanchInfo` | **收获** |
| `AnimalService.FeedAnimal` | `1: [{ranch_inst_id, animal_inst_id}]` `2: feed_type` | `RanchInfo` | **投喂** |
| `AnimalService.TriggerProduce` | 空 | `RanchInfo` | 触发生产 |
| `AnimalService.StealProduce` | `1: host_gid` | 好友 `RanchInfo` | **偷产物** |
| `RanchService.CleanAllRanch` | `1: host_gid` `2: ranch_inst_ids[]` | `RanchInfo` | **一键清理** |
| `RanchService.GetRanchOpTimes` | `1: op_ids[]` | `OpQuota[]` | 配额 |
| `HomesteadService.GetBuildingList` | 空 | 建筑列表 | 设施 |
| `HomesteadService.GetFacilityDetail` | `1: facility_inst_id` | `FacilityDetail` | 牧草机状态 |
| `FeedMachineService.AddFeed` | `1: facility_inst_id` `2: count` | `FeedMachineState` | **牧草机加料** |

### 通知

`gamepb.homesteadpb.FacilitiesNotify`（38 条）—— 牧场动物/牧草机状态变化都走这条。
`network.js` 的 `handleNotify` 加这一个分支即可被动感知变化。

### 实测数据样本

```
RanchInfo        ranch_inst_id=10001  capacity=4  animal_count=4
AnimalInst       animal_inst_id=7  animal_id=60002  stage=1
                 grow_ready_at_ms=1794816364540  infant_ready_at_ms=1794812764540
                 can_feed=true  can_donate=true
                 expected_harvest_exp=360   expected_harvest_sells=[{id:1007, count:2160}]
                 expected_produce_exp=180   expected_produce_sells=[{id:1007, count:1620}]
                 mutation={strokable:true}
OpQuota          {op_id:11003, limit:100, used:100}
                 {op_id:11008, limit:20, remaining:20}
                 {op_id:11009, limit:10, remaining:10}
FacilityDetail   facility_inst_id=10002  name="牧草机"  facility_id=7001001  level=8
                 cost={id:1007, count:6000}  module_type=2  capacity=100
                 feed_machine={capacity:99, current:72, speed_level:1, state:3}
```

**动物 ID**：60001 / 60002 / 60003（种类）
**牧草机**：`facility_inst_id=10002`，`facility_id=7001001`

## B. 关键结论

1. **请求体加密、响应体明文**。这是本次最大的实现坑：请求要
   `tsdkRuntime.decrypt()`，响应直接 protobuf 解码。搞反会得到错位的
   field number（例如解出 `field 1310`）。
2. **WS 帧前面有 HTTP 101 响应头**。剥离 `\r\n\r\n` 之前的部分，否则
   分帧从错误偏移开始，整条连接的消息全乱。
3. **牧场的道具 ID 空间与农场不同**。`expected_*_sells` 里的 `id=1007`
   在农场 `ItemInfo.json` 里不存在（农场金币是 1001），说明它是牧场专用
   道具，需要 `MCItemInfo`（加密表）才能拿名字。
4. **`op_id` 是 11xxx 段**（农场是 10003/10004/10008/10015）。抓到的
   11003/11008/11009 语义尚未确认，需要对照操作再抓一轮。
5. **`AnimalInst` 自带 `expected_harvest_exp` / `expected_produce_sells`**，
   收益判断不需要配置表，直接读回包即可。

## C. 仍然缺样本的操作

| 缺口 | 影响 |
|---|---|
| 买动物 / 放入栏舍（补栏） | 无法自动补栏 |
| 扩建 capacity | 无法自动扩栏 |
| 单个灾害处理（只抓到 `CleanAllRanch`） | 只能一键清，不能定点 |
| `op_id` 与操作的对应关系 | 配额计数算不准 |
| 好友牧场进入（`StealProduce` 只有 1 次样本） | 偷产物链路不完整 |

## D. 抓包工具链（可复用）

抓包服务是**内嵌在 bot 进程里的 MITM 代理**（`core/src/capture/`），
本次给它加了一个原始流量落盘开关：

```bash
cd core
CAPTURE_DUMP_DIR="D:/tmp/pasture-capture/frames" node capture-server.js
```

- 默认关闭（不设 `CAPTURE_DUMP_DIR` 就完全不落盘），不影响原有抓包登录功能。
- 落盘为 `<sessionId>.jsonl`，一行一个数据块 `{t, cid, host, dir, len, b64}`，
  `dir` 取 `chead` / `c2s` / `s2c`，`cid` 区分连接。
- 只对 `config.captureHosts`（含 `*.nqf.qq.com`）做 MITM。

分析流程（Node）：

```js
// 1. 解 WS 帧（复用 core/src/capture/ws-parser.js），s2c 先剥 HTTP 101 头
// 2. GateMessage 解码 → meta.service_name / meta.method_name
// 3. c2s 的 body 用 TsdkRuntime.decrypt() 解密；s2c 的 body 直接解
```

注意：dump 里包含完整业务帧和登录 code，**不要提交到仓库**。

---

# 实现状态（2026-11-16 晚）

## 已完成：最小闭环

| 新增文件 | 职责 | 测试 |
|---|---|---|
| `core/src/proto/pasturepb.proto` | animalpb 全部消息 | 8 个响应真机验证 |
| `core/src/proto/homesteadpb.proto` | homesteadpb 牧草机相关 | 同上 |
| `core/src/services/pasture-api.js` | 10 个 RPC 收口 | `pasture-api.test.js` 10/10 |
| `core/src/services/pasture-analyzer.js` | RanchInfo → 可操作列表 | `pasture-analyzer.test.js` 8/8 |
| `core/src/services/pasture-orchestrator.js` | 收货架→收获→投喂→清理→补草 | `pasture-orchestrator.test.js` 10/10 |
| `core/src/services/pasture.js` | barrel | — |

| 修改文件 | 改动 |
|---|---|
| `core/src/utils/proto.js` | 加载两个新 proto，注册 26 个类型 |
| `core/src/models/store.js` | `DEFAULT_AUTOMATION` 加 `pasture` 与四个子开关 |
| `core/src/config/config.js` | `pastureCheckIntervalMin/Max`（20–30 秒） |
| `core/src/core/worker.js` | `nextPastureRunAt` + `runPastureTick` + unified tick 接入 |

## 关键设计决定

1. **判断优先用服务端布尔标志**（`can_harvest` / `can_feed` / `can_collect`），
   本地阶段推断只作兜底。服务端标志已经综合了草料、成熟度、每日次数，
   自己再推一遍容易和服务端不一致。
2. **牧场间隔比农场稀疏（20–30 秒）**。牧场操作种类少、产物周期长，
   而请求预算和农场共用；拉太勤会把农场的抢收预算挤掉。
3. **有成熟墙钟时才精确定时**。`getNextPastureReadyInMs()` 返回 0 表示
   没有已知时刻，此时按常规间隔复查，绝不长睡（和农场
   `OWN_MATURITY_GAP` 的教训一致）。
4. **补草有 5 分钟冷却**，且一次只补 1 份，避免把库存打空。
5. **牧场 tick 给农场收获让路**：`ownHarvestIsDue()` / `isImminent(1500)`
   时直接 return，因为农场抢收的时间窗更窄。

## 仍然没做

| 缺口 | 原因 |
|---|---|
| 买动物补栏（`emptySlots` 已算出来了，但没有下单链路） | 商城→放入栏舍的协议没抓到样本 |
| 扩建 capacity | 同上 |
| 单个灾害定点处理 | 只有一键 `CleanAllRanch` |
| 好友牧场偷产物调度 | `StealProduce` 的 API 已备好，但没有并入 friend 轮次 |
| 面板入口（`/api/pasture`、`Pasture.vue`、菜单项） | 不在本次最小闭环范围内 |
| `op_id` 语义（11003/11008/11009） | 需要对照操作再抓一轮 |

## 怎么验证

```bash
cd core
node --test test/pasture-api.test.js test/pasture-analyzer.test.js test/pasture-orchestrator.test.js
# 28 tests / 28 pass
```

全量回归：`npm test` → 1179 项 / 1167 通过 / 12 失败（均为既有 Windows 限制）。

---

# 第二轮抓包结果（2026-11-16 晚）

2.0MB / 用户操作覆盖：买动物→放入栏舍、单点清理、进好友牧场（催生产/偷产物/返回）、重进游戏。

## 新增 3 个 RPC（补上最小闭环的缺口）

| 方法 | 请求（实测解码） | 用途 |
|---|---|---|
| `AnimalService.PlaceAnimal` | `targets: [{ranch_inst_id:10001, animal_id:60001}]` | **补栏**，服务端自动分配 slot |
| `RanchService.CleanRanch` | `host_gid`, `hazard_ids: [11]`（packed repeated） | **定点清理** |
| `RanchService.StrokeAnimal` | `host_gid`, `target: {ranch_inst_id, animal_inst_id}` | 抚摸动物 |

`StealProduce` 也补全了：可带 `target` 指定偷哪只（`{host_gid, target}`），
不带时是偷全部可偷。

**关键区别**：`PlaceAnimal.animal_id` 是**动物种类号**（60001），不是实例号
（animal_inst_id）——服务端负责造实例和分配栏位。

## 买动物：复用农场的 ShopService

抓包确认买动物走的就是 `gamepb.shoppb.ShopService.BuyGoods`，参数与农场一致
（`goods_id` / `num` / `price`）。

动物商店的实测数据：

```
goods_id=10002  item_id=60001  price=2       ← 新手动物，几乎免费
goods_id=10003  item_id=60002  price=1080
goods_id=10004  item_id=60003  price=2712
goods_id=10005  item_id=60004  price=4068
...
共 16 种，price 单位是 item 1007（牧场货币）
```

`shop_id` 无法从抓包确定（请求体加密，解出来是随机字节），因此
`getAnimalShop()` 遍历候选 `[2, 4, 5]`，返回第一个含 `item_id` 落在
60000–60999 段的商店，并缓存结果。

## gid 语义确认

用 `Heartbeat` 请求交叉验证（它是发给自己，一定正确）：

- **自己 = 1284046759**（与 `PlayerLogin` 回包的 `basic.gid` 一致）
- 出现过的其他 gid（`1288674344` / `1233369866` / `1285654584` / 1219347822 …）
  都是好友，或切换过的账号

因此 `host_gid` 的语义是「被操作牧场的主人」：清理/偷取/抚摸好友时传好友 gid，
操作自己时传自己 gid。`pasture-api.selfGid()` 取的是 `getUserState().gid`，正确。

> **注意**：仓库数据目录 `accounts.json` 里这个账号记录的 gid 是 `1288674344`，
> 与登录态不符（那是好友的）。不影响运行（运行时 gid 来自登录回包），
> 但看数据时别被误导。

## 修掉一个真实 bug

`isAnimalItemId()` 最初写的是 `Number(itemId)`。但 protobufjs 解 int64 给的是
**Long 对象**，`Number(Long)` 返回 NaN，导致动物商店永远匹配不到、补栏静默失效。
已改为 `toNum()`（能处理 Long / number / {low,high}）。测试里也补了对应断言。

## 新增配置

| 键 | 默认 | 说明 |
|---|---|---|
| `pasture_refill` | `true` | 补栏：把背包里的动物放进空栏 |
| `pasture_buy_animal` | **`false`** | 自动买动物。要花牧场货币，默认关闭 |

补栏动作顺序固定为「先背包、后购买」：背包里有动物就绝不花钱。

## 当前测试

```bash
cd core && node --test test/pasture-api.test.js test/pasture-analyzer.test.js test/pasture-orchestrator.test.js
# 42 tests / 42 pass
```

全量 `npm test`：1193 项 / 1181 通过 / 12 失败（均为既有 Windows 限制）。

## 仍然没做

| 缺口 | 状态 |
|---|---|
| 好友牧场偷产物**调度** | API 已完备（`stealProduce(gid, target)`），但没并入 friend 轮次 |
| `op_id` 语义（11003/11008/11009） | 本轮只抓到 1 次配额查询，缺对照样本 |
| 抚摸/变异玩法 | `strokeAnimal` 已收口，未接入编排 |
| 面板入口 | 不在当前范围 |

---

# 面板与好友偷取（2026-11-16 收尾）

## 后端新增

| 文件 | 内容 |
|---|---|
| `core/src/controllers/admin-pasture-routes.js` | `GET /api/pasture`、`POST /api/pasture/operate`（op 白名单校验） |
| `core/src/services/pasture-visit.js` | 好友牧场偷产物 |

`worker.js` 的 `handleApiCall` 加了两个 case：
- `getPasture` — 拉详情 → 分析 → `buildPanelView()`，一步出面板数据
- `doPastureOp` — 手动触发一轮（`all` / 单项）

`data-provider.js` 对应加 `getPasture` / `doPastureOp`，
`admin.js` 注册路由。

## 一个关键区别：好友偷取不需要门票

农场的偷菜要走 `VisitService.Enter` → 分析 → 操作 → `Leave`，四步。
牧场的 `StealProduce` **直接用 `host_gid` 指名**，一次请求就完事，不需要进入/离开。

所以 `pasture-visit.js` 很薄：

```
拉好友列表 → 逐个 GetRanchDetail(host_gid) → 有 can_steal 的货架就 StealProduce(gid)
```

护栏：
- `pasture_steal` 默认 **false**（每轮会给每个好友多发一次请求）
- 单轮最多查 5 个好友
- 5 分钟冷却
- 单个好友失败不影响其他好友

`GetRanchDetail` 的 proto 补上了 `host_gid = 1`（第二轮抓包确认：同一方法在好友
牧场场景出现过 8 个不同 gid）。

## 面板

| 文件 | 内容 |
|---|---|
| `web/src/stores/pasture.ts` | Pinia store：`fetchPasture` / `operate` / 账号切换丢弃过期响应 |
| `web/src/views/Pasture.vue` | 视图：汇总卡片、单项操作、动物网格、货架/灾害/空栏 |
| `web/src/router/menu.ts` | 菜单项「牧场」（`i-carbon-home`） |

视图特性：
- 20 秒轮询（牧场变化慢，不跟 bot 抢预算）
- 未连接时不打接口，只显示提示
- 操作完立刻刷新，不等下一次轮询
- 动物卡片显示栏位、阶段、产物倒计时、预期经验、变异品阶/体重
- **动物名字拿不到**（在加密的 `MCItemInfo` 表里），面板显示 `动物 #60001`

## 设置开关（7 + 1 个）

`AutomationSettingsTab.vue` 新增「牧场自动化」分组：

| 开关 | 默认 |
|---|---|
| `pasture` 牧场巡查 | 开 |
| `pasture_harvest` 自动收获（含货架） | 开 |
| `pasture_feed` 自动投喂 | 开 |
| `pasture_clean` 自动清理灾害 | 开 |
| `pasture_refill` 自动补栏（用背包动物） | 开 |
| `pasture_grass` 自动给牧草机补草 | 开 |
| `pasture_buy_animal` 自动买动物（花牧场币） | **关** |
| `pasture_steal` 偷好友牧场产物 | **关** |

前端的 `useAutomationSettings` / `stores/setting.ts` / `DefaultPlanSettingsTab`
三处默认值也同步补齐，避免面板读不到字段。

## 测试

```bash
cd core && node --test test/pasture-*.test.js
# 51 tests / 51 pass
#   api 17 / analyzer 12 / orchestrator 17 / visit 8 / routes 9
```

全量 `npm test`：1214 项 / 1202 通过 / 12 失败（既有 Windows 限制）。

前端：`vue-tsc --noEmit` 0 错误，`vite build` 成功（`dist/assets/Pasture-*.js`）。

## 仍然没做

| 缺口 | 原因 |
|---|---|
| 动物/设施的中文名 | 在加密的 `MCItemInfo` / `MCFacilityConfig` 表里，未解 |
| `op_id` 语义（11003/11008/11009） | 两轮抓包各只有 1 次配额查询，缺对照样本 |
| 抚摸/变异玩法 | `strokeAnimal` API 已收口，未接编排（收益不明） |
| 扩建 capacity | 用户未执行该操作，无样本 |

---

# 抚摸玩法 + 中文名（2026-11-16 补充）

## 抚摸（strokeAnimal）已接入编排

用户实测确认：**抚摸会推进动物产出**。抓包参数结构：

```
StrokeAnimal  1: host_gid   2: {ranch_inst_id, animal_inst_id}
```

编排里的位置：**收获之后、投喂之前**（抚摸推进产出，越早做越好）。

节流（服务端对抚摸有配额，宁可少摸也不撞上限）：
- 同一只动物 **10 分钟**内不重复摸
- 单轮最多摸 **5 只**
- 只摸 `AnimalMutation.strokable == true` 的动物

新增开关 `pasture_stroke`（默认开）。分析器输出 `strokable[]`，
面板加「抚摸」按钮和第 6 张汇总卡片。

## 中文名：静态解不开，改成可填表

`MCItemInfo`（984,593 B）确实是那个 984K 的表，但它不是明文 yml。

真实结构是 **Cocos 的 `cc.TextAsset`**：

```json
[1,0,0,[["cc.TextAsset",["_name","text"],1]],[[0,0,1,3]],
 [[0,"MCItemInfo","FSpk...984500 个字符..."]]]
```

`text` 字段是 `FSpk` 开头的私有格式。**穷举验证过以下可能，全部不成立**：

| 尝试 | 结果 |
|---|---|
| base64 直接解 | 738371 B，%4=3，非 4 字节对齐 → 不是 XXTEA |
| 单字节 XOR（256 key） | 无一产生合法 UTF-8 |
| 单字节加/减（各 256） | 无一产生合法 UTF-8 |
| zlib / gzip / brotli（偏移 0–32 各试） | 全部 Z_DATA_ERROR |
| TSDK `decrypt()` | 输出变随机（可打印 0.38），说明不是 TSDK 格式 |
| CCON 字符串表（u8/u16/varint 长度 × 偏移 0–40） | 无一处能连续解析出合法字符串 |

数据特征：熵 7.22、可打印 74%、256 种字节全出现、可打印段与高字节段交替。
**解析逻辑在客户端里，而客户端字符串被 TSDK 字节码 VM 加密，静态读不出来。**
要拿原名只能 hook 运行时（改包有签名校验，微信小游戏也注入不了）。

**所以做成可填表** `core/src/gameConfig/PastureNames.json`：

```json
{
  "animals":   { "60001": "鸡", "60002": "..." },
  "facilities": { "7001001": "牧草机" }
}
```

- 没填时面板显示 `动物 #60001` / `设施 #7001001`（占位，不编造）
- 填了立刻生效，面板和日志都用真名
- 文件缺失或为空不影响任何功能

`gameConfig.js` 新增 `getPastureAnimalName(id)` / `getPastureFacilityName(id)`。

**已知的设施名**：`7001001 = 牧草机`（抓包时 `FacilityDetail.name` 直接返回了中文，已填）。

**待填的动物名**：抓包的 16 种动物 `60001`–`60008` 及以上，需要进游戏看一眼对应关系。

## 测试

```bash
cd core && node --test test/pasture-*.test.js
# 67 tests / 67 pass（api 17 / analyzer 12 / orchestrator 21 / visit 8 / routes 9）
```

全量：1218 项 / 1206 通过 / 12 失败（既有 Windows 限制）。

---

# 中文名：28 个动物全部拿到（2026-11-16 最终）

## 结论：不需要填表了

一开始我判断「FSpk 解不开，只能人工填」。**这个结论是错的** —— 不是解不开的问题，
是我**取数的方向错了**：名字不需要从加密的配置表里挖，**商店接口直接给了 id、价格**，
游戏界面上写着名字。

## 动物的两段 ID 空间

之前只发现了窝类，漏掉了棚类：

| 类型 | item_id 段 | 商店 goods_id |
|---|---|---|
| 窝 | `60001`–`60016` | 10002-10007、10010-10011、10014-10015、10018-10019、10022-10023、10026-10027 |
| 棚 | `70001`–`70012` | 10008-10009、10012-10013、10016-10017、10020-10021、10024-10025、10028-10029 |

棚类是我第一次导出商品表时看漏的（只看了前 8 条）。

## 完整映射（28 个，价格全部吻合）

| 窝类 | 价格 | | 棚类 | 价格 |
|---|---|---|---|---|
| 60001 鸡 | 2 | | 70001 羊 | 5640 |
| 60002 鸭 | 1080 | | 70002 牛 | 10152 |
| 60003 鹅 | 2712 | | 70003 驴 | 8448 |
| 60004 兔子 | 4068 | | 70004 迷你猪 | 12672 |
| 60005 火鸡 | 5640 | | 70005 马 | 10560 |
| 60006 天竺鼠 | 6768 | | 70006 水牛 | 15840 |
| 60007 乌龟 | 8448 | | 70007 骆驼 | 12672 |
| 60008 松鼠 | 12672 | | 70008 牦牛 | 19008 |
| 60009 刺猬 | 10560 | | 70009 鸵鸟 | 15216 |
| 60010 鼹鼠 | 15840 | | 70010 梅花鹿 | 22824 |
| 60011 考拉 | 12672 | | 70011 浣熊 | 18240 |
| 60012 狐狸 | 19008 | | 70012 羊驼 | 27360 |
| 60013 豪猪 | 15216 | | | |
| 60014 龙猫 | 22824 | | | |
| 60015 孔雀 | 18240 | | | |
| 60016 貂 | 27360 | | | |

**三重验证**：
1. 商店截图：名字 + 价格 + 窝/棚标签
2. 抓包 `ShopInfo`：`goods_id → item_id → price`
3. 28 项价格**逐个吻合**，没有一处冲突（窝类与棚类价格大量重复，
   例如火鸡与羊都是 5640，靠 goods_id 顺序区分开）

已写入 `core/src/gameConfig/PastureNames.json`，测试断言 28 个 id 都返回真名、
没有占位。

> 注意 `70001`（羊，动物）与 `7001001`（牧草机，设施）不是一回事。

## 为什么配置表仍然解不开（保留记录）

`MCItemInfo` / `MCAnimalConfig` / `MCFacilityConfig` 是 `cc.TextAsset`，
`text` 字段为 `FSpk` 私有格式。已穷举排除：base64 直解、单字节 XOR×256、
单字节加减×512、zlib/gzip/brotli×偏移0-32、LZ4 block、base85、二次 base64、
位旋转、TSDK decrypt、CCON 字符串表（u8/u16/varint × 偏移0-40）、
2 字节 XOR×65536、4 字节 key（8 种 JSON 开头反推）。

也确认了：
- 客户端里没有 XXTEA 常量（`0x9E3779B9` / `2654435769` 均 0 次）
- mcboot 里 `atob`/`charCodeAt`/`fromCharCode` 全为 0，解析不在这
- `src/bundle-scripts/mcRes/index.7725a.js` 只有 `SpineSilhouetteGlow2`，没有解析器
- `ShopInfo` 响应无 name 字段

**但这条路已经不需要了** —— 名字从商店价格反推更直接。

## 关于「未解锁所以没有」

用户的猜测部分正确：未解锁的动物**骨骼资源**确实没下载（`spine/` 只有
60001-60018 + 6010001），但**商店列表始终完整**，所以名字和价格一直在本地
可读的接口里。

---

# 真机测试发现的两个 bug（2026-11-16 夜）

第一次在真机上跑，暴露了两个静态分析看不出来的问题。

## bug 1：proto 字段定义错位，动物全丢

**现象**：面板显示 `0/3 栏位`，日志 `检查失败: invalid wire type 7 at offset 33`。
但同一个接口手动切过去能看到 3 只鸡。

**根因**：`HarvestRanchReply` 的 field 5 我定义成了 `repeated OpResult`。
实际它是「本次收获明细」，结构是这样的：

```
field 5 (repeated):
  1: 10001          ← ranch_inst_id
  2: 1              ← ?
  3: 7              ← animal_inst_id
  10: {len=17}      ← 收获产物（内含 field 4/100 等）
```

protobufjs 按 `OpResult`（op_id / error_code / error_message）去解，
读到 field 10 时当成 string，长度对不上就错位，后面全部崩，`animals` 全丢。

`CleanRanchReply`（field 2）和 `TriggerProduceReply`（field 3）是同一个毛病。

**修法**：这些 Reply **只保留 `ranches`**，其余字段不定义 ——
protobufjs 会按未知字段跳过，不会错位。反正代码里也没用到它们。

**验证**：用抓包里全部 45 条响应重新解码，
`HarvestRanch` 从 4 失败变 0，`CleanRanch`/`TriggerProduce` 各从 1 变 0，总失败 0。

回归测试直接把当时失败的 462 字节响应内联成 fixture。

## bug 2：空闲防护把牧场饿死

**现象**：首次 tick 打过 `牧场就绪` 之后就再也没动静。

**根因**：`planIdleProtection()` 只用 `farmAt` / `helpAt` 算「空闲期间整体暂停」：

```js
let until = Math.min(Number(farmAt) || now, Number(helpAt) || now);
```

牧场 20–30 秒就要跑一轮，但农场/帮助要等 7 分钟，
于是 `until - now = 7分钟 >= 60秒` → 整轮暂停 7 分钟，牧场永远等不到。

**修法**：`planIdleProtection` 接受 `pastureAt` 并参与 `Math.min`。
只在传了有效值时才参与，保持不传时的旧行为不变。

**验证**（真机）：

```
08:56:23  农场：没事做，先歇 18分
08:56:46  [pasture] 牧场就绪        ← 25 秒后牧场照样跑
「重点防护」出现次数：0             ← 修复前必现
```

## 另一个顺手修的

`isAnimalItemId()` 用 `Number(itemId)`，而 protobufjs 解 int64 给的是 Long，
`Number(Long)` 是 NaN → 动物商店永远匹配不到。改用 `toNum()`。

## 当前测试

```
core: 牧场 76 项全绿（api 19 / analyzer 19 / orchestrator 22 / visit 8 / routes 9）
全量：1228 项 / 1216 通过 / 12 失败（既有 Windows 限制）
前端：pnpm build:web 通过（vue-tsc + vite）
```

## 测试时要注意

跑起来后面板能读到牧场状态，但**牧场当前是空的（0/3 栏位）**，
所以看不到收获动作。想验证完整闭环，需要先有动物：

- 进游戏放一只，或
- 打开 `pasture_buy_animal` 让 bot 自己买（最便宜的是鸡，2 牧场币）

---

# 与农场全面对齐（2026-11-16 夜，第二轮）

目标是把牧场做成「和农场一样」：同样的自动化粒度、同样的入口位置、同样的首页展示。

## 一、牧场任务（新增能力）

**这是本轮最重要的发现**：牧场不是没有任务，而是**和农场共用同一个 `TaskService`**，
只是拉列表时要带 `scene_id = 2`（`GLOBAL_SCENE_ID_BIG_FARM`），
且任务类型只用 4/5/6（家园成长 / 家园每日 / 家园支线），农场是 1/2/3。

来源是 mcboot 分包里的官方功能文档《牧场任务系统》：

> 与农场 `TaskManager` **完全独立**（独立 Manager / Model / Event），
> 共用主包 `TaskService`（taskpb），拉列表固定 `scene_id = 2`。

### scene_id 字段号是怎么确定的（不是猜的）

`TaskInfoRequest` 原本是空 message，文档只写了 `{ scene_id: 2 }`，没写字段号。
但抓包给出了硬证据：

| | 请求 body |
|---|---|
| 农场 `TaskInfo` | **0 字节** |
| 牧场 `TaskInfo` | **2 字节，hex `e998`** |

TSDK 加密是**确定性**的，且**不改变长度**。于是直接拿 TSDK 加密反推：

```
明文 08 02  →  密文 e998   ★ 与抓包完全一致
明文 10 02  →  d498        ✗
明文 18 02  →  0598        ✗
明文 08 01  →  e970        ✗
```

所以 `scene_id` 就是 **字段 1**，值 2。这是证明，不是推测。

### 实现

- `core/src/proto/taskpb.proto`：`TaskInfoRequest { int32 scene_id = 1; }`
- `core/src/services/task.js`：
  - `getTaskInfo(sceneId = 0)` —— 传 0 时 body 为空，与旧行为完全一致
  - `checkAndClaimPastureTasks()` —— 只挑 `task_type` 4/5/6，逐条 `doClaim`
  - `getPastureTaskSummary()` —— 只读，供面板
- 开关：`pasture_task`（默认**开**），**独立于**农场的 `task`：
  两套进度，关掉农场任务不该连带停掉牧场。
- `worker.js` 的 `runPastureTick` 里跟着牧场一起跑。

### 真机结果

```
GET /api/pasture/tasks
  {"total":4,"claimable":3,"items":[
    {"id":300004,"desc":"生产3次","category":"pasture_growth","progress":3/3,"canClaim":true},
    {"id":400001,"desc":"完成1次生产","category":"pasture_daily","progress":1/1,"canClaim":true},
    {"id":400003,"desc":"完成1次收获","category":"pasture_daily","progress":1/1,"canClaim":true}]}

POST /api/pasture/tasks/claim  →  {"claimed":3}
GET  /api/pasture/tasks        →  claimable 3 → 1
```

## 二、自动化补强

**推送触发**：`FacilitiesNotify` 之前被当成「未识别推送」丢掉。
现在解码并分发 `facilitiesChanged`，把下一轮牧场 tick 拉到 1.5 秒内
（3 秒去抖，好友牧场的通知不叫醒自家 tick）。
真正的决策仍以 `GetRanchDetail` 的最新快照为准 —— 推送只负责叫醒，不负责判断。

**间隔可配**：`intervals.pastureMin / pastureMax`（默认 20/30 秒），
写进「策略设置 → 巡查时机」，跟农场/帮助/偷菜并列。

## 三、首页与入口

**概览首页**：新增「牧场」卡，六格 —— 栏位 / 可收获 / 待投喂 / 货架 / 牧草 / 可领任务，
右上角直接跳「我的牧场」。倒计时卡里也加了「牧场」一行（`nextChecks.pastureRemainSec`）。
牧场状态 60 秒拉一次（比面板的 20 秒稀疏），切账号立刻重拉。

**个人页**：`Personal.vue` 从 3 个 tab 变 4 个 —— 我的农场 / **我的牧场** / 我的背包 / 我的任务。
面板抽成 `web/src/components/PasturePanel.vue`，结构与 `FarmPanel` 对齐：
卡片头 + 药丸汇总 + 内容区。侧边栏的「牧场」项改为 `showInNav: false`，
路由保留给深链接。

## 四、对齐情况总表

| 农场能力 | 牧场 | 说明 |
|---|---|---|
| 巡查 tick | ✅ | 加了推送触发 |
| 自动收获 | ✅ | 含货架 |
| 自动种植 | ✅ | 对应「补栏」，先背包后购买 |
| 浇水/除草/除虫 | ✅ | 对应「投喂/清理」 |
| 精确抢收 | ✅ | 用 `grow/produce_ready_at_ms` |
| 自动任务 | ✅ **本轮新增** | `scene_id=2` |
| 自动卖果实 | ✅ | 货架收取 |
| 好友互动 | ✅ | 偷产物（默认关） |
| 推送触发巡田 | ✅ **本轮新增** | `FacilitiesNotify` |
| 巡查间隔可配 | ✅ **本轮新增** | `intervals.pastureMin/Max` |
| 概览首页状态 | ✅ **本轮新增** | 独立卡片 + 倒计时行 |
| 个人页入口 | ✅ **本轮新增** | 第 4 个 tab |
| 自动控制开关 | ✅ | 10 个 |
| **图鉴** | ❌ 牧场没有 | 官方文档写明「图鉴等后置」；`IllustratedService` 只有作物/鲜花/树木，无动物 |
| **土地升级/扩建** | ⏸ 无明文协议 | 建筑升级 RPC 被 TSDK VM 加密，无样本；按项目规矩不猜 |

## 五、测试

```
pasture-task.test.js   9 项（scene_id 编码 / 只领 4·5·6 / 开关独立 / 空开销）
牧场全套              86 项全绿
```

`scene_id` 那条测试验证过「去掉字段就失败」：把 proto 里的 `scene_id` 删掉，
立刻挂 2 项，加回来 9 项全过。

---

# 真机闭环验证（2026-11-16 夜，第三轮）

这一轮把牧场真正跑起来，也踩到两个「字段名猜不得」的坑。

## 一、验证通过的部分

端到端跑通，日志原样：

```
09:56:33 [pasture] 买入并补栏 1 只动物（goods 10002，花费 2）
09:56:33 [pasture] 本轮操作：refill_slots
09:56:40 [pasture] 投喂 1 只动物
09:56:40 [pasture] 清理 1 个灾害（定点）→ feed → clean
09:56:40 [task]   发现 1 个可领取牧场任务
09:56:40 [task]   领取(牧场每日): 清理1次牧场 → 物品#80021x5
```

自动买动物、补栏、投喂、定点清理、领牧场任务，全部自主完成。
面板侧「我的牧场」tab、"概览页牧场卡"、"牧场倒计时行"也都用浏览器逐项确认过渲染。
`TriggerProduce` 那批动物后来没再被误收（连采 12 次 × 15 秒，栏位稳定在 1/3）。

## 二、坑 1：HarvestRanch 是「一键收获出栏」，不是「收货架」

`performCollectShelves` 原本用 `harvestRanch()` 收货架。真机表现：
日志打「收货架 3 个（3 项）」之后，栏位从 3/3 直接变 0/3 —— **鸡全被收出栏了**。

官方文档「牧场操作 RPC」把两者分得很清楚：

| 用途 | 客户端方法 | RPC |
|---|---|---|
| 收取副产品 | `collectProduce` | **`CollectProduce`** |
| 收获出栏 | `harvestAnimal` | `HarvestAnimal` |
| 一键收获 | `oneKeyHarvest` | `HarvestRanch` |

**现在**：`performCollectShelves` 只记录待收数量，不发请求。
`CollectProduce` 没有抓包样本，按项目规矩不猜 proto。宁可货架堆着，也不能再误收动物。

## 三、坑 2：TriggerProduce 是「一键开轮」，不是「开始生产」

文档里它标的是「开始生产」，但 mcboot 的 `MCOneKeyTriggerProduceOp.ts` 注释写的是
**「一键开轮」**。真机两次复现都是后者：

```
10:23:07 触发生产 3 只动物
10:23:18 收货架 3 个（3 项）
        → 栏位 3/3 变 0/3，动物没了
```

**调用一次 = 这个栏位这一轮直接跑完并出栏**，产物进货架。

**现在**：完全不自动调用，只在待开工数量变化时记一条日志。
`pasture_produce` 开关已删除（前后端一起清掉），不给用户留一个会清空牧场的按钮。

## 四、能力边界（诚实版）

| 能力 | 状态 |
|---|---|
| 补栏（先背包后买） | ✅ 真机验证 |
| 投喂 | ✅ 真机验证 |
| 清理灾害（定点） | ✅ 真机验证 |
| 领取牧场任务 | ✅ 真机验证 |
| 巡查开关/间隔/推送触发 | ✅ |
| **收获出栏** | ✅ 代码路径对（`can_harvest` → `HarvestRanch`），但要等动物自然产出才有对象 |
| **收副产品（货架）** | ⏸ 缺 `CollectProduce` proto，不发请求 |
| **启动生产** | ⏸ `TriggerProduce` 语义危险，不自动调用 |

动物会随时间自然进入 `producing=true`（抓包里就有这种样本），
所以不调 `TriggerProduce` 也能等到产出，只是要等真实时间。

## 五、顺带修的

- **面板看不到幼崽/成长中的动物**：`buildPanelView` 只遍历
  「可收获 / 待投喂 / 生产中」三个动作分类，刚买的鸡（stage 1-2）
  不属于任何一类，整个从面板消失。改为遍历 `allAnimals`。
- **概览页牧场卡首屏恒为 0/0**：`refreshPasture` 卡了 `realtimeConnected`，
  首屏 WS 还没连上就直接 return。改为只看 accountId，并在 WS 连上后补拉一次。
- **`<Transition mode="out-in">` 卡死 tab 切换**：`Personal.vue` 切 tab 时按钮高亮变了，
  面板却停在旧组件上（加不加 `:key` 都一样）。去掉过渡层后四个 tab 都正常。
- **运行策略补齐**：新增「优先补栏动物」（对应农场优先种子）和
  「偷产物白名单」（对应农场偷菜白名单），进「策略设置 → 牧场策略」。

---

# 第四轮：把 TriggerProduce 判对了，CollectProduce 判死了

## 一、修正：TriggerProduce 是安全的（上一轮判错了）

上一轮看到「触发生产」之后动物消失，就认定它会清空栏位。**那是错的。**

单独做了一次干净实验，只调 `TriggerProduce`，别的什么都不做：

```
实验前：栏位 3/3，货架 0
后：TriggerProduce → ok，返回完整 ranches
后：栏位 3/3（动物还在！），货架 3 个槽位各 5 项产物
```

**动物是在上一步「收货架」里被 `HarvestRanch` 收走的**，和 `TriggerProduce` 无关。
两个操作在日志里前后脚出现，才看错了因果。

所以 `pasture_produce` 开关恢复，自动流程恢复调用。真机日志：

```
11:55:01 触发生产 1 只动物 → trigger_produce
11:55:12 货架有 1 个待收（需要 CollectProduce，跳过）
11:55:12 收获 1 只（预期 +1 经验）→ harvest
```

从买入、投喂、清理、触发生产到收获出栏，一整轮养殖全自动跑完。

## 二、CollectProduce：服务端不可用，不是字段问题

`TriggerProduce` 能返回业务码 `1045232`（当前没有可以生产的），说明链路是通的。
但 `CollectProduce` **无论发什么都是 `1020002 网络繁忙`**。

穷举排除过的组合：

| 维度 | 试过 |
|---|---|
| service | `AnimalService`、`RanchService` |
| 空 body | ✅ |
| `ranch_inst_ids` 字段号 | 1 / 2 / 3 |
| 编码形态 | varint、packed repeated、嵌套 message |
| 带 slot_index | 1 / 5 |
| 静默 70 秒后单发 | 排除限流 |

**全部同一个错误码**，而同期 `TriggerProduce` 正常 → **不是限流、不是参数**。
是方法未实现，或请求体结构比这些猜测复杂得多。

**结论**：`collectProduce()` 保留在 `pasture-api.js` 但加了大段警告注释，**当前不调用**。
货架产物会堆着，用户进游戏手动收。要打通最后一段，需要抓一次游戏里点
「收取副产品」的包 —— 有字节我就能像 `scene_id=2` 那样反推出来。

## 三、今日统计对齐

农场的「今日统计」有一堆计数器，牧场之前一个都没接。现在补齐 7 项：

`pastureHarvest / pastureFeed / pastureClean / pastureStroke / pastureRefill / pastureGrass / pastureSteal`

真机验证（跑了几轮之后）：

```json
{"Harvest": 11, "Feed": 14, "Clean": 2, "Stroke": 0, "Refill": 8, "Grass": 0, "Steal": 0}
```

概览页「今日统计」里直接可见，图标和配色与农场项一致。

## 四、当前完整状态

```
买入 → 补栏 → 投喂 → 清理灾害 → 触发生产 → 产物进货架 → 收获出栏
  ✅     ✅      ✅        ✅          ✅           ⚠️          ✅
                                                （收不走）
```

唯一缺口是货架那一段。动物会走完整个生命周期，牧场币也会持续消耗
（`pasture_buy_animal` 打开时）—— 这是养殖循环本身的设计，不是 bug。
