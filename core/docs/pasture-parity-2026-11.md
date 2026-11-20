# 牧场能力对齐（2026-11-20）

参考实现：`602832789/qq-farm-bot` v3.31.0 的 `core/src/services/ranch/`。
本项目命名保持 `pasture`，不重命名，避免历史测试与面板文案大面积改动。

## 一、协议层（已重建）

删除了自建的 `proto/pasturepb.proto`，改用完整三件套：

| 文件 | 内容 |
| --- | --- |
| `proto/animalpb.proto` | 动物/栏舍/货架/灾害/操作结果 |
| `proto/ranchpb.proto` | 「场景 2」专用副本（背包/商店/图鉴/分享/集市/进入好友家园） |
| `proto/homesteadpb.proto` | 格子、设施、建筑、牧草机（字段语义按官方定义重写） |

关键决定与证据：

- **字段编号相同、命名不同**：`HarvestRanchRequest.field 3` 旧名 `harvest_type`，官方名 `op`；
  `FeedAnimalRequest.field 2` 旧名 `feed_type`，官方名 `bucket_type`。编号一致，wire 兼容。
- **旧 `homesteadpb.proto` 的字段语义是错的**：同一份抓包
  `1:10002 2:"牧草机" 4:7001001 5:8 6:{1007:6000} 7:1 8:7001001 9:10 10:7 12:2 13:2 14:100`
  旧解读为 `5=level=8 / 13=module_type=2 / 8=template_id`，自相矛盾；
  官方解读 `5=module_type=8(牧草机) / 12=width / 13=height / 7=level / 14=capacity` 自洽。
  只有 `feed_machine.feed_count`（f1 = 当前草量）此前已被证伪验证，保持不变。
- **同名消息必须分 namespace**：`ranchpb.Item` 带 `show/item_detail/tab_id`，
  `corepb.Item` 没有；`ranchpb.ReportShareRequest` 与 `sharepb.ReportShareRequest` 同名不同号。
  因此 `utils/proto.js` 把 `animalpb / homesteadpb / ranchpb` 全部注册成 `Ranch<Name>`，
  牧场代码只用 `types.RanchXxx`，杜绝混用。
- `corepb` 补 `FacilityOpResult`、`ItemEntry`；`userpb` 补 `ShareInfo`；
  `shoppb` 补 `ShowCond` 与 `BuyGoodsRequest.auto_add`；`mallpb` 补 `PurchaseLimit`
  与 `GetMallListBySlotTypeRequest.is_manual_open/global_scene_id`。

`HarvestRanchReply.field 5` 就是 `repeated FacilityOpResult`（不是当年猜的「未确认明细」）。
真机样本 `core/test/pasture-api.test.js` 的 `HARVEST_FAIL_HEX` 现在能正确解出
`ranches + op_results`，动物不再丢。

## 二、执行安全模型（新增）

三个模块，缺一不可：

1. `services/pasture-context.js` —— AsyncLocalStorage 发送上下文。父上下文透传，
   `check` 返回错误即拒发，`onSent` 只在真正写进 socket 后回调。
2. `utils/network.js` —— `sendMsg` / `sendMsgAsync` 支持 `beforeSend` / `onSent`。
   `onSent` 放在 `ws.send` 成功之后：写失败、被拦截都不算「已发出」。
3. `services/pasture-operations.js` —— 盘上账本
   `<dataDir>/pasture-operations/<sha256(accountId)>.json`。
   记录 `{id,target,label,costs,createdAt,message}`，`costs` 同时充当余额预留。

判定规则（`pasture-actions.operate`）：

- `sent === 0` → 网关层拒绝，撤销记录（肯定没有副作用）。
- `sent === 1` 且唯一一次调用就是本动作且抛 `GatewayError` → 同样撤销（服务端明确报错）。
- 其它（超时/断线/多次发送）→ 保留记录、写 `outcomeUnknown`，同 `target` 再次提交直接
  `PENDING_CONFIRMATION`，必须人工 `acknowledge`。

## 三、报价 / 确认两段式（新增）

`services/pasture-actions.js`：

- `planAction(action, input, raw)`：校验准入条件、算 `costItems/expectedRewards/marker`，
  输出 `expected.signature`。
- 签名 = `JSON.stringify({action, payload, costs, rewards, marker})`，键顺序固定，
  不排序、不规范化；`costs[].amount` 与 `rewards[].count` 都是十进制字符串。
- `operate(action, input)`：重新报价 → 比对 `input.expected.signature`
  （不一致抛 `RANCH_OFFER_CHANGED`）→ 账本占位 → 发包 → 回包逐项核对。
- `count === 0` 先返回 `skipped`，**先于**签名校验：无事可做不该报报价变化。

覆盖 23 个动作：`buy / place / addGrass / useCan / feed / produce / harvest / sell /
clean / activateShed / upgrade / completeUpgrade / claimTasks / reportEntry / exchange /
claimIllustrated / claimDailyShare / buyCan / steal / stroke / putMosquito /
cleanFriend / release`，外加 `acknowledge`。

回包核对：`op_results` 的 `facility:kind:target` 集合必须落在本次操作范围内，
重复目标直接判 `RANCH_RESULT_UNKNOWN`；一键操作只放行「读取后才成熟/新冒出来的」目标。

## 四、新增能力与开关

| 开关 | 默认 | 动作 |
| --- | --- | --- |
| `pasture_market_poop` | false | 集市：便便(7002) → 有机化肥 80012/80011 |
| `pasture_market_pinecone` | false | 集市：松果(1008) → 80013/80012/80011 |
| `pasture_upgrade` | false | 棚激活 / 设施升级 / 完成升级 |
| `pasture_fill_cans` | false | 背包罐头 → 桶（Use，不消耗） |
| `pasture_feed_normal` | false | 普通桶(7003)喂养 |
| `pasture_feed_organic` | false | 有机桶(7004)喂养 |
| `pasture_illustrated` | false | 普通图鉴 + 巨大图鉴重量档领奖 |
| `pasture_share` | false | 每日首次分享礼包（share 102 / doc 2101） |
| `pasture_daily_benefit` | false | 罐头商城每日免费商品 2001 |
| `pasture_friend_mosquito` | false | 给好友放蚊子（配额 11003） |
| `pasture_friend_clean` | false | 帮好友清理 |
| `pasture_release` | false | 放生（配额 11008） |
| `pasture_use_scene` | false | 动作执行放进牧场场景（每轮多两次场景登录） |

`pasture_feed` 保留：两个细项都没开时，仍走原来的单一投喂路径。

编排顺序（`runPastureOperation('all')`）：
`收获 → 生产 → 抚摸 → 喂养 → 清理 → 集市 → 设施 → 图鉴 → 补栏 → 补草 →
填罐 → 每日分享/福利 → 好友互动`。

## 五、HTTP 契约

读：`GET /api/pasture`、`/animals`、`/animal-stats`、`/tasks`、`/ledger`。
写：`POST /api/pasture/operate`（自动化轮次）、`/tasks/claim`、
`/:action/quote`（报价）、`/:action`（带 `expected.signature` 执行）。

`:action` 必须最后注册，否则会截获固定路径。

## 六、配额与预算

- `request-governor` 增加 `VisitService.EnterHomestead / LeaveHomestead = 16/60s`、
  `FriendService.GetFriendList = 20/60s`。这三个都是「遍历好友」入口，
  不压住会把 `GetRanchDetail` 挤掉，表现为牧场详情读不到。
- 好友互动每轮最多 3 个好友、5 分钟冷却。

## 七、场景进出（已实现）

新增文件：

- `proto/globalscenepb.proto` —— `PlayerSceneLogin` / `PlayerSceneLoginReply` /
  `GlobalSceneUnlockNotify`。
- `services/automation-lock.js` —— 全局串行锁，可重入、支持 `detached` 与
  排队超时。农场、牧场、好友访问共用一条连接，切场景必须互斥。
- `services/pasture-scene.js` —— `inRanchScene(run, options)`：
  进场景（`loginGameScene(2)`）→ 用 `RanchSceneData.homestead_cells` 解出初始快照 →
  执行 → `finally` 切回原场景；恢复失败调 `invalidateGameScene` 并给结果打
  `sceneRestored:false / refreshRequired:true`；执行期间断线（socket 变了）不补发恢复。

`network.js` 新增 `loginGameScene` / `invalidateGameScene`，`userState` 增加
`globalSceneId` / `unlockedSceneIds`，并处理 `GlobalSceneUnlockNotify`。

接入点：

- `pasture-actions.operate` —— 所有写操作都在场景内执行（已在场景时零成本）。
- `pasture-visit.checkFriendPastures` —— 整轮进一次场景，逐个好友
  `EnterHomestead → 读详情/偷取 → LeaveHomestead`（`finally` 保证离场，
  中途 `continue` 也不例外）。
- `pasture-orchestrator` —— 开关 `pasture_use_scene`（默认 **false**）开启后，
  整轮动作在场景内执行；读详情仍在场景外做，无事可做时不付两次场景登录的代价。
  另加 `SCENE_ENTER_MIN_INTERVAL_MS = 30s` 节流：窗口内不重复切场景，
  退回 `host_gid` 直连。

两个必须知道的现实约束：

1. 本项目登录走**旧版** `LoginRequest`，回包里没有 `unlocked_scene_ids`，
   因此解锁列表可能一直是空的。`isRanchUnlocked()` 把「空列表」当未知、
   一律放行；只有明确收到 `GlobalSceneUnlockNotify` 且不含 2 时才判定未解锁。

   **微信端根本不走这条路**（2026-11-20 修正）：解包微信小游戏（v84）后确认，
   主包 `subpackages/main/game.js` 里 `PlayerSceneLogin` / `GlobalSceneService`
   出现 **0 次**，客户端从不切全局场景；而该账号牧场 4/4 栏位、草 72、
   收获/投喂/清理/生产/捡蛋/集市/分享/任务/好友全部在 scene 1 直连跑通。
   所以 `PlayerSceneLogin(2)` 的 `code=1045002` 并不代表「牧场未解锁」
   ——牧场好好的，是微信端没有这个场景。现在按平台分流：
   `CONFIG.platform !== 'qq'` 时直接跳过场景（`sceneSkipped: 'platform_unsupported'`），
   一个请求都不发。QQ 端仍然尝试，并按下述规则降级。

   **QQ 端「放行去试」必须配「失败后记住」**：
   首个真实账号上 `PlayerSceneLogin(2)` 返回 `code=1045002`，
   而最初的实现在失败后既不记忆也不降级，于是每轮都白发两次注定失败的登录，
   还把 `checkPasture` 和好友巡查整轮打成「检查失败」。QQ 端的规则是：

   - 收到 1045002 → 记到 `userState.ranchSceneBlockedAt`，**本轮回退直连把活干完**；
   - 30 分钟内不再尝试进场景，日志只打一条；
   - `GlobalSceneUnlockNotify` 含 2 时立即解除，重新尝试；
   - 只有网络类错误照常上抛，不会被误记成「未解锁」。

   这条能成立的前提是：**牧场 RPC 在场景外本来就可用**——该账号没有进过牧场场景，
   但 `GetRanchDetail` 照样返回 4 个栏位、草 74，牧场任务也扫到 4 个。
   场景只是「更符合服务端预期」，不是功能前提。所以 `inRanchScene` 默认
   `onLocked: 'fallback'`（就地执行，结果标 `sceneSkipped`），
   只有真正依赖场景快照的调用方才传 `onLocked: 'throw'`。
2. `visitpb.VisitService` 的 proto 里只声明了 `Enter/Leave`，实际方法名是
   `EnterHomestead/LeaveHomestead`（消息来自 ranchpb）。方法名是硬编码字符串，
   protobufjs 不校验。

## 七点五、真机联调发现的两个 bug（2026-11-20）

首个真实账号跑起来后暴露了两个真问题，都已修：

1. **场景未解锁把整轮牧场打死**（见上一节）。原实现在 1045002 后既不记忆也不降级，
   每轮白发两次注定失败的登录，`checkPasture` 与好友巡查双双「检查失败」。
   现在降级直连 + 30 分钟冷却重探。
2. **`pasture_feed` 误用 `FeedAnimal` 烧罐头**。`AnimalService.FeedAnimal` 是
   「喂罐头」而不是免费投喂——真机返回 `code=1045234 罐头桶已耗尽`，说明它会按桶
   扣罐头，那一轮实际烧掉了 4 个普通罐头。免费投喂的路径是牧草机
   `FeedMachineService.AddFeed`。现在 `pasture_feed` 等价于「饿了就补草」，
   `performFeed` 直接委托 `performRefillGrass`；主动喂罐头只走
   `pasture_feed_normal` / `pasture_feed_organic`，且提交前先查桶余量。
   测试里加了一条防回归断言：投喂路径**绝不能**出现 `feedAnimal`。

## 七点六、真机日志里剩下的无效请求（同日修）

清掉上面两个 bug 之后，日志还剩下三类「每轮必发、每轮必失败」的请求，
都按「识别幂等语义 / 记住结论」处理掉了：

| 现象 | 业务码 | 处理 |
|---|---|---|
| 每日分享每轮都失败 | `1009001` 分享奖励已经领取 | 视为已完成，当天不再请求 |
| 每日商城福利每轮都失败 | `1031003` 限购次数已用完 | 视为已完成，当天不再请求 |
| 好友列表里的非好友 gid | `1045216` 你们还不是好友 | 记住该 gid，后续轮次直接跳过 |

顺带把业务码统一暴露成 `err.code`（原先只有 `serverErrorCode`），
上层不必再各自正则解析 message。

## 八、遗留问题（明确未做/未验证）

1. **巨大图鉴的 `is_new` 清理**未做（需要 `illustratedpb` 的 clear-new 路由）。
2. `MallGoods` 仍沿用项目内旧的 bytes 结构（wire 与官方一致但不直观），
   罐头商城靠 `parseMallPrice` + 手动解 `item_ids` 读取，后续可考虑换成结构化定义。
3. 所有新动作**只做了协议级与单元测试**，尚未用真实账号跑过一轮线上验证；
   建议先在测试账号上只开 `pasture_illustrated`、`pasture_share` 这类无成本开关，
   确认 `PlayerSceneLogin` 在当前客户端版本仍然可用后再开 `pasture_use_scene`。

## 九、验证方式

```bash
cd core && node --test test/pasture-*.test.js test/governor-pasture-budget.test.js test/proto-readiness.test.js
```

当前 183 项全通过。全仓 `node --test test/*.test.js` 有 17 项与本次改动无关的
环境性失败（Windows 上 `0600/0700` 权限断言、扫码相关桩件、drupe 用例超时）。