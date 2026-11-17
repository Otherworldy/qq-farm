# 请求治理器：预算上限的依据

## 治理器是干什么的

`core/src/services/request-governor.js` 是**自我约束**的护栏，服务端并不要求它：

| 功能 | 作用 |
|---|---|
| 硬预算 | 60 秒滑动窗口，超总量或单接口上限就丢弃请求 |
| 画像 | 按 `service.method` 统计成功/失败，喂每日安全巡检 |
| 异常降速 | 短窗口内错误过多 → 放慢普通巡查（不冻结成熟抢收） |

目的是让自动化的请求量**不像机器人那样失控**，从而降低被风控处置的风险。

## 数字必须有依据，不能撞到就调高

历史沿革（**全部没有基准，纯靠撞到就调**）：

```
40/15 → 80/30 → 110/30 → 120/36 → 140/36 → 160/48 → 200/55
```

每次都是「日志出现预算拦截 → 调高上限 → 警告消失」，从没问过
**官方客户端自己一分钟发多少**。那段时间的注释写「160 仍远低于异常风暴量级」
——这句话当时没有任何数据支撑。

## 现在有了：官方客户端实测

分析工具：`core/scripts/analyze-har-rate.js`

```bash
node core/scripts/analyze-har-rate.js <官方客户端 HAR>
```

原理：游戏走 WebSocket（`gate-obt.nqf.qq.com`），HAR 里每帧带 `flow`
（0=客户端发出）和毫秒时间戳；请求 payload 虽然加密，但 **protobuf 头部
的服务名和方法名是明文**，所以既能数总量也能数单接口。

样本：Windows 微信小游戏 `1.17.0.3_20261117`，正常游玩 160 秒（种、收、
巡田、放虫放草、牧场）。

| 指标 | 实测值 |
|---|---|
| 启动 30s 内 | 123 次 = **246 次/分钟** |
| 30s 后稳态 | 246 次 = **113 次/分钟** |
| 60s 滑动窗口峰值 | **278 次** |
| 最高单接口峰值 | `PlantService.PutWeeds` **55/60s** |
| 次高 | `PutInsects` 45、`GetGameFriends` 20、`Enter`/`Leave` 各 16 |
| 牧场 | `AnimalService.GetRanchDetail` 峰值 9/60s |

## 由此定下的取值

```
TOTAL_LIMIT     = 200   # 官方稳态 113 的 1.8 倍，官方峰值 278 的 72%
PER_METHOD_LIMIT = 55   # 官方实测最高单接口峰值
```

**关键结论：官方客户端自己就能一分钟发 278 个请求而账号无恙。**
所以护栏压到 160 以下会拦掉我们自己的正常业务，而提到 200 依然在官方
实测范围之内。

## 已知的结构性差异（不是违规，但值得优化）

| 接口 | 官方峰值 | 我们 |
|---|---|---|
| 好友列表读取 | `GetGameFriends` 20 + `GetAll` 2 + `GetBriefInfo` 8 ≈ 30 | `GetAll` **36-38** |
| 好友访问 | `Enter`/`Leave` 各 16 | 各 **30** |
| 牧场详情 | `GetRanchDetail` 9 | **2-3** |

- 好友访问频率约是官方的 2 倍（自动化巡查 vs 手动点）
- 牧场反而比官方**稀疏**（我们 20-30 秒一轮，官方峰值 9/60s）
- `GetAll` 36 次主要来自「读取门成功即重置」+ 偷菜快路径 1.5-3 秒一读；
  这频率被 `friend-summary-backoff*.test.js` 的归因精度契约锁住，不能随手改

前两项如果要向官方靠拢，得改巡查架构，不是调预算能解决的。

## 提交约定

HAR 含登录 code 和 gid，**不提交**。只提交 `analyze-har-rate.js`、
本文件和 `request-governor.js` 里的注释。

## 落地：按基准调整后的实际效果

| 调整 | 之前 | 之后 |
|---|---|---|
| 预算 | 160/48（无依据） | **200/55（官方实测基准）** |
| 牧场轮询 | 20-30 秒 | **7-10 秒**（官方 GetRanchDetail 峰值 9/60s） |
| 好友列表读取 | 36-38 次/60s | **约 2-3 次/60s** |

实测（6 分钟）：**治理器拦截 22 次 → 1 次**，窗口不再常驻满载。

`GetAll` 从 36 掉到 2-3 次并不是靠加节流 —— 那会挂 8 项测试（
`friend-summary-backoff*.test.js` 明确要求 `checkFriends` 每次调用都尝试读取）。
真正的原因是**上一轮删掉偷菜分支的 `return`**：恢复后 `runStealTick` 跑完
正常把下次唤醒推到 `stealRediscoveryDelayMs()`（5-8 分钟），而不是被
反复叫醒重读列表。**饿死其它 tick 的那行 `return` 同时也是请求风暴的源头。**

### 仍有一处产物收不走

`CollectProduce` 服务端始终返回 `1020002`（已穷举字段组合同样结果），
所以货架产物只能留给用户进游戏手动收。日志已改为「数量变化才记一条」，
否则 7-10 秒一轮会把它刷满。

---

# 单接口限额也要有基准：好友巡查独占预算的教训

上一轮把总量定成 200 / 单接口 55 之后，真机日志仍然持续报拦截：

```
FriendService.GetAll×55
VisitService.Enter×49
VisitService.Leave×49
PlantService.AllLands×12   ← 农场读地块
TaskService.TaskInfo×11
AnimalService.GetRanchDetail×7
```

三件套合计 **153/200，占掉七成六**，实际后果是：

- `农场常规施肥：获取土地信息失败…请求被治理器拦截(budget_total): AllLands`
- `任务检查任务失败: 请求被治理器拦截(budget_total): TaskInfo`
- `系统获取全农场地块失败: 请求被治理器拦截(budget_total): AllLands`

## 原因

`PER_METHOD_LIMIT = 55` 是**所有方法共用一个上限**。55 这个值来自官方最高单接口
峰值 `PutWeeds` 55/60s，但官方那个 55 只属于除草。好友巡查在官方客户端里是：

| 接口 | 官方实测 | 我们允许 | 实际发出 |
|---|---|---|---|
| `GetGameFriends`（我们的 `GetAll`）| **20** | 55 | 55 |
| `Enter` | **16** | 55 | 49 |
| `Leave` | **16** | 55 | 49 |

**我们给了好友巡查近三倍于官方的额度**，它自然就吃满了。

## 修法

`core/src/services/request-governor.js` 增加按方法限额表：

```js
const METHOD_LIMITS = new Map([
    ['gamepb.friendpb.FriendService.GetAll', 20],
    ['gamepb.visitpb.VisitService.Enter', 16],
    ['gamepb.visitpb.VisitService.Leave', 16],
]);
```

其余接口仍用 `PER_METHOD_LIMIT`（55）。施肥 HOT 窗口的 ×3 放宽保留，
作用在各自的基础限额上。

重算总量：好友巡查最高 52，总预算 200 还剩 148 给农场 + 牧场，而它们的实际
用量是 `AllLands 12 + TaskInfo 11 + GetRanchDetail 7 + Bag 8 ≈ 40`，宽裕。

测试 `core/test/har-rate-baseline.test.js` 里锁住这三个值，改动必须同步改测试。
