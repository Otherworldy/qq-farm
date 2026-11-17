# 项目目标

- 主工作区：当前仓库根目录。
- 旧版参考项目：本机另行保存的旧版参考副本。查旧功能、接口行为、文案和流程时先对照它，但不要机械复刻旧 UI。
- 目标是把 QQ 农场自动化工具整理成前后端更易维护、容易排查、方便扩展的结构。
- 重构方向：统一目录和模块边界，减少冗余和历史代码味道，降低阅读/修改成本，逐步解耦架构与依赖。
- 非目标：不做无关大改，不一次性全站格式化，不把“复刻 2.3.1 UI”当成目标。

# 当前状态

- 2026-10-20 移除自动进化 agent（改为全部人工更新）：删除 `activity-evolver.js`、
  15 个 `evolution-*.js`、`feishu-notify.js`、`approved-runtime-entry.js`、4 个进化
  脚本、`scripts/evolution-hooks/`、面板 `EvolutionAgentSettings.vue` 与
  `stores/evolution.ts`，以及 34 个进化测试。保留活动更新扫描
  （`activity-update-monitor.js` + `/api/activity/update/status|scan`）、微信凭据
  保活（`auto-code-refresh.js`）、隐私脱敏（`privacy-guard.js`）与通用重启脚本
  `scripts/restart-bot.sh`。`warehouse.js` / `daily-events.js` /
  `auto-code-refresh.js` 里的 `recordRuntimeIssue` 投递点一并移除，背包与事件
  上报只保留日志。

- 2026-10-20 微信端 TSDK 升级：从本机 Windows 微信 4.x 缓存
  （`%APPDATA%\Tencent\xwechat\radium\users\<hash>\applet\packages\wx5306c5978fdb76e4\75`）
  解出微信小游戏包，TSDK 为 `v3.9.0.1792070005`（161133 字节，SHA-256
  `1a9416db8b328e8957a079c583ffc5fc7e48d6af8c45aa40d9969dd68157beca`）。
  `inspect:tsdk` 确认 22 个 imports、61 个 exports、17 个数据段和
  `decrypt_all_data` 密钥常量 `1871261153` 与上一版完全一致，属“仅版本、哈希和代码体
  变化”。默认运行文件已切换为 `tsdk-v3.9.0.1792070005.wasm`，`tsdk-v3.9.0.wasm`
  保留用于回退。TSDK/网关定向测试 6/6 通过；在线 5/30 分钟验收待测试账号。
- Windows 微信 4.x 的 `.wxapkg` 带 `V1MMWX` 加密（AES-256-CBC 前 1024 字节 + 其余
  整段 XOR）。新增 `npm run unpack:wx`（`core/scripts/unpack-wxapkg.js`）自动定位
  最新版本目录、解密并解包，纯 Node 实现、只读源缓存。
- `extract:plant-phases` 不再只认 QQ：自动探测 QQ macOS 与微信 Windows/macOS 的
  `usr/gamecaches`，按 `usr/gamecaches/` 公共路径解析而不依赖 `qqfile://` 前缀，
  并新增 `--cache-root` 显式指定。微信端 `cacheList.json` 与植物目录结构与 QQ 一致。
- 2026-10-20 在线验收（微信端）：容器内扫码登录“耀西不爱做检查”（Lv22）成功，
  `ACE 初始化成功：v3.9.0.1792070005，耗时 12ms`，15 块土地（森野甜莓）全部读取，
  无 checksum mismatch、无 AntiData 上报失败；活动中心、背包、好友列表均正常。
  静态比对 74/75 两个包：ACE 暴露的 13 个 JS API 与 WASM 的 22 imports / 61 exports /
  17 数据段完全一致，17 个数据段中 15 个字节完全相同，仅剩 2 段各 394 字节
  （同一份加密元数据的两份副本）不同，因此本次升级属常规版本更新，检测能力未变。
- 2026-10-20 数据补齐：`EventPlants.json` 增加茱萸 `seed_id 20165`（Crop_165、
  单格、`fruit 40165×48`，与铃兰 20108 同档）；`EventItems.json` 增加
  黄金·森野甜橙 `1040527`（`gold/Crop_527`，图标未取得官方资源，走通用回退）。
- 2026-10-20 日志治理：`network.js` 未知推送改为按类别静默（`RedDotNotify` /
  `ListChangedNTF` / `ActiviesChangeNotify` / `ItemUseDailyNotify`），业务推送仍告警；
  `batchGetFriendDogInfo` 治理器拦截不再逐条 warn，改由批次汇总 `governedCount`，
  并把好友间隔从 0.5-1.5s 放宽到 2-3.5s，避免 60+ 好友时打满 80/min 总预算排掉
  活动与偷菜请求。

- TSDK/ACE 安全链路已升级到 QQ Mac 客户端 2026-08-20 10:32 包内的官方
  `v3.9.0.1787057219` WASM（161114 字节，SHA-256
  `98cc5301cff10f5b87a014d0a4af92630e4a6e91292cc7de5eb86422275f0070`）。
  同包 `game.js` 和 WASM 静态检查确认 22 个 imports、导出映射、
  `SdkInitEx(3167, 0)`、17 个 mergewasm 数据段及解密密钥均与现有 Node 宿主兼容；
  默认运行文件已切换为 `tsdk-v3.9.0.wasm`（即 `v3.9.0.1787057219`，已被
  2026-10-20 微信端升级条目取代，仅作历史与回退记录），保留 `tsdk-v3.8.6.wasm` 用于回退。
  语法检查、定向 ESLint 和 6/6 TSDK/网关测试通过；完整后端套件中 TSDK 项通过，
  总计 152/153 通过，既有 `capture-core` 代理启动用例在当前环境失败，未改动该模块。
  调用映射和内存所有权见 `core/docs/tsdk-ace-runtime.md`；受控在线 5/30 分钟好友
  操作仍需测试账号实测。
- WASM 后续更新已标准化：新增 `core/scripts/inspect-tsdk-update.js` 和
  `npm run inspect:tsdk`，可静态输出 SHA-256、imports、exports、active data
  segments、解密高频常量、`game.js` 版本/关键标记及基线兼容性；完整发现、快照、
  差异分级、更新、离线/在线验收和回退流程见
  `core/docs/tsdk-update-runbook.md`。
- 技术栈：后端 `core` 是 Node.js/CommonJS + Express + Socket.IO；前端 `web` 是 Vue 3 + Vite + TypeScript + Pinia + UnoCSS。
- 最新快速体检结果：`web/src` 全量 ESLint 通过，`web` 生产构建通过；`core/src/**/*.js` 全量 `node --check` 通过。源码扫描未发现真实替换字符类乱码、孤立 `undefined` 行或 `_v###` 反编译变量残留；`core` ESLint 因本地 `core/node_modules` 缺少 `@antfu/eslint-config` 未作为源码失败处理。
- UTF-8 源码扫描未发现 `core/src`、`web/src` 存在真实替换字符类乱码；PowerShell 仍可能把中文显示成乱码，不能据此改源码。
- 已完成第一批低风险前端规范清理：背包空态分支、主题读取空块、确认框无意义绑定、微信扫码调试输出、静态正则、`Friends.vue` 定义顺序、`Login.vue` 换行格式。
- `Renewal.vue` 已修复登录态入口与续费分支：`/renewal` 不再因有效 token 被路由守卫强制跳回 dashboard；已登录用户进入续费页会预填并锁定当前用户名，提交走 `/api/user/renew` 并同步本地用户信息；未登录用户仍走 `/api/public/renew`。旧版参考副本仅作为接口行为参考，未照搬产物。
- 登录页“账号续费”闭环已补齐：`Login.vue` 会把当前输入用户名带到 `/renewal`，`Renewal.vue` 公共续费成功后带用户名回 `/login`，登录页会在输入框为空时从 query 回填用户名；已登录用户续费仍走当前账号锁定流程。
- `Login.vue` 已开始结构瘦身：卡密领取结果弹窗、找回密码验证弹窗和设置新密码弹窗已抽到 `web/src/components/login/LoginModals.vue`，父页面保留登录/注册/找回密码请求与状态 wiring，行为不变。
- 登录密码强度逻辑已抽离：评分规则在 `web/src/composables/usePasswordStrength.ts`，展示条在 `web/src/components/login/PasswordStrengthMeter.vue`，登录注册表单和重置密码弹窗复用同一套规则与 UI。
- `Friends.vue` 的 QQ 好友自动同步设置块已抽到 `web/src/components/friends/FriendsSyncSettings.vue`；父页面保留设置保存/刷新/GID 弹窗状态，组件负责展示设置项、统计提示和入口按钮。
- `Friends.vue` 的好友列表卡片与分页已抽到 `web/src/components/friends/FriendsFriendList.vue`；父页面继续持有好友筛选、展开状态、操作确认、黑名单和头像错误状态。
- 后台连接堆积导致网站打不开的问题已做防护：`core/src/controllers/admin.js` 增加 HTTP request/header/keep-alive/idle socket 超时、连接 close 清理、JSON 请求体大小限制和 `/api/health`；`core/src/models/user-store.js` 将 IP 登录失败限制加硬为 1 分钟 6 次后锁 10 分钟，并在登录成功后清理当前 IP 失败计数。
- 页面切换短暂显示“未登录/账号未登录”的问题已修复：`status` store 新增当前账号状态就绪标记，`Dashboard.vue`、`Friends.vue`、`FarmPanel.vue`、`BagPanel.vue`、`TaskPanel.vue` 只在确认当前账号离线后显示离线空态，并避免组件首次挂载时清空已有账号状态。
- `Dashboard.vue` 已去掉顶部重复状态卡、日志说明条、动作说明条和中间重复摘要卡；保留账号资源卡、运行日志、筛选、倒计时和今日统计，仪表盘信息密度更低、干扰更少。
- `Shop.vue` 已把商城标题、账号资源、分区切换、排序和刷新收敛到一条稳定横栏；删除无引用的 `ShopOverviewPanel.vue`、`ShopInfoCard.vue`，去掉分区概览统计卡和各分区商品列表前的说明条，购买流程保持不变。
- `Illustrated.vue` 已把图鉴标题、解锁/未解锁/可购买/Lv 状态、图鉴类型切换、筛选、一键购买和刷新收敛到一条稳定横栏；去掉“当前查看建议、当前阻塞汇总、当前筛选下”等解释型摘要和重复统计卡，图鉴卡片和购买流程保持不变。
- 图鉴卡片已抽到 `web/src/components/illustrated/IllustratedItemCard.vue`，卡片密度、圆角、网格列数、图片区域、状态胶囊和底部按钮区已对齐商城商品卡；图鉴图片增加加载失败兜底。
- `Activity.vue` 已按商城/图鉴同款结构收紧：活动中心标题、荷露余额、今日剩余、奖池、兑换数量、当前账号、抽奖/兑换切换和刷新统一到顶部横栏；删除无引用的 `ActivityNavigation.vue`、`ActivityOverview.vue` 和旧活动卡类型，荷露抽奖/兑换流程保持不变；活动奖励图片增加加载失败兜底，避免显示破损图片。
- 活动中心已接入本期 4 个子活动入口：奇遇礼莲、荷露商店、荷风游记、节令小札；后端 `normalizeHeluGroup` 会从活动树中标准化子活动节点参数（id/title/status/time/payload），前端只展示这 4 个入口，不恢复已过期的粽香大比拼。奇遇礼莲/荷露商店继续绑定已验证抽奖/兑换操作，荷风游记/节令小札先展示活动节点参数，等确认协议操作字段后再补交互。
- `Friends.vue` 已去掉好友页顶部说明、好友总数/黑名单/最近访客/已知 GID 统计卡，以及“当前分区说明/当前局部结论”摘要组件；删除无引用的 `FriendsStatsGrid.vue`、`FriendsSummaryCards.vue`，保留搜索、tab、QQ 同步设置、好友列表、黑名单和访客功能。
- `Friends.vue` 已修复好友管理页后台刷新后自动回到顶部的问题：整页加载态只在首次无数据时显示，已有数据刷新不再卸载主体内容；账号 watcher 也收窄到账号 id/运行状态变化，避免普通账号对象更新触发列表重载。
- 布局账号入口已调整：新增 `TopAccountMenu.vue`，将账号切换、添加账号、管理账号和备注编辑入口从左侧栏搬到顶部栏右侧；`Sidebar.vue` 删除原账号选择块，左侧更专注于用户信息、导航和底部状态。
- 左侧导航菜单已简化为短标签：概览、个人、好友、活动、商城、图鉴、分析、设置、后台；后台仍保留管理员可见限制。
- 活动页荷露抽奖点完后疑似掉线的问题已做保守防护：`core/src/services/activity.js` 对活动 Operate 增加连接状态检查，免费多抽改为串行节流请求并延迟刷新活动状态；`web/src/views/Activity.vue` 防止抽奖请求重复提交。服务已重启，`/api/health` 返回 200。
- 蹲守与飞升/秒偷功能已完全去除：前端设置 tab、独立蹲守页、相关组件、setting store 字段、后端 `/api/instant-steal`/`/api/stakeout` 路由、worker RPC/自动启动、runtime provider/config snapshot、store 配置模型和对应 service 文件均已删除；源码残留扫描无匹配。
- `core/src/controllers/admin-bag-routes.js` 已从 `_v###`/逗号表达式风格清理为命名 helper + 清晰路由处理；接口路径、主要返回结构和旧版缺账号行为保持对齐。
- `core/src/controllers/admin-farm-resource-routes.js` 已清理为命名 helper + 清晰路由处理；`/api/status` 缺账号 200 返回、其它资源接口缺账号 400 的旧行为保持对齐。
- `core/src/controllers/admin-public-info-routes.js` 已清理为命名 helper + 清晰路由处理；公共信息、更新日志、鉴权校验和 scheduler fallback 的返回结构保持对齐。
- `core/src/controllers/admin.js` 已完成入口可读性清理：CORS、静态资源、鉴权门、SPA fallback、Socket.IO 订阅逻辑均已命名化；`core/src/controllers/admin*.js` 当前无 `_v###` 残留。
- 已完成的关键结构成果：`Activity.vue`、`Settings.vue`、`Shop.vue` 已拆成页面协调器 + 组件/composables；`Friends.vue` 已开始拆页面壳，标题/搜索、统计卡、摘要提示和 tab 条已抽到 `web/src/components/friends/`；后端 `admin.js` 已拆出大量领域路由，入口主要负责启动、注册、静态资源、鉴权和 Socket.IO。
- `AdminPanel.vue` 已继续结构拆分：登录日志面板已抽到 `web/src/components/admin/AdminLoginLogPanel.vue`，登录日志状态/格式化/清空逻辑已抽到 `web/src/composables/useAdminLoginLogs.ts`，清空确认弹窗已抽到 `web/src/components/admin/AdminLoginLogConfirmModal.vue`；卡密面板已抽到 `web/src/components/admin/AdminCardPanel.vue`，卡密状态、筛选、复制、创建、删除和领取开关逻辑已抽到 `web/src/composables/useAdminCards.ts`，卡密确认弹窗已抽到 `web/src/components/admin/AdminCardConfirmModals.vue`；用户面板已抽到 `web/src/components/admin/AdminUserPanel.vue`，用户状态、统计、续费、封禁、删除、清理到期和编辑逻辑已抽到 `web/src/composables/useAdminUsers.ts`，用户确认弹窗已抽到 `web/src/components/admin/AdminUserConfirmModals.vue`；系统配置面板已抽到 `web/src/components/admin/AdminSystemPanel.vue`，系统/微信配置状态、加载、保存、重置和确认框开关已抽到 `web/src/composables/useAdminSystemConfig.ts`，对应确认弹窗已抽到 `web/src/components/admin/AdminSystemConfigConfirmModals.vue`；后台通用提示弹窗已抽到 `web/src/components/admin/AdminAlertModal.vue`；顶部汇总和 tab 外壳已抽到 `web/src/components/admin/AdminPanelHeader.vue`、`web/src/components/admin/AdminPanelTabs.vue`，页面目前主要负责模块 wiring。
- 活动能力状态：Helu 活动可见；南瓜活动后端保留但前端隐藏，属于 dormant/hidden 能力。
- 当前只保留 `progress.md` 作为接力摘要；`maintenance.md` 已删除，后续维护信息写回本文件但保持短而有用。

# 当前优先级

1. 继续拆高风险大页面，优先 `Friends.vue` 或 `AdminPanel.vue`，其次 `Login.vue`、`Sidebar.vue`、`Dashboard.vue`、`Analytics.vue`。
2. 继续拆 `AdminPanel.vue`，优先按卡密、用户、系统配置拆成 focused components/composables。
3. 对照本机旧版参考副本补齐/核对功能时，只迁移必要行为，按当前项目结构重落地。
4. 目录结构统一要随着模块拆分逐步做，不要先做大规模移动造成引用噪音。

# 关键决策

- 大页面只做协调器；业务规则、状态组合、重复 UI 拆到 composables、stores 或 focused components。
- 后端入口只做 wiring；具体接口按领域放到 `admin-*-routes.js` 和领域 helper/service 中。
- 后端 admin 控制器目录的 `_v###` 债务已清空；后续不要重新引入逗号表达式/反编译式临时变量风格。
- 隐藏或内部能力必须在接力记录中说明；尤其南瓜活动不要重新暴露到导航或活动页，除非用户明确要求。
- 中文乱码判断以 UTF-8 真实内容为准；终端乱码先用 Node 读取文件确认。
- 前端全量 ESLint 当前可通过；继续优先对触碰文件跑 targeted lint，阶段性再跑全量 lint 和构建。
- `git status`/`git diff` 在当前 worktree 曾不可用或不可靠；继续工作以实际文件内容和命令检查为准，不依赖 git 状态判断。

# 未完成待办

- 前端结构治理：
  - `Friends.vue`：页面仍大；标题/搜索、统计卡、摘要提示和 tab 条已抽到 `web/src/components/friends/`。下一步适合继续拆 QQ 好友自动同步设置块、好友列表项/分页、访客列表或 GID 弹窗。
  - `AdminPanel.vue`：主要面板 UI、卡密/用户/日志/系统配置逻辑、全部后台弹窗模板、顶部汇总和 tab 外壳均已抽离；页面目前主要保留各模块 wiring，后续优先转向 `Friends.vue`、`Login.vue`、`Sidebar.vue` 等仍偏大的页面。
  - 快速排查显示剩余主要债务不是语法错误，而是大文件和类型边界：`Friends.vue`、`Login.vue`、`Sidebar.vue`、`Dashboard.vue`、`Analytics.vue`、`models/store.js`、`core/worker.js`、`models/user-store.js`、`services/activity.js` 等仍适合分批拆分；前端大量 `any` 应优先从 store/API 边界和高频页面逐步收窄。
  - 逐步减少 `any`，优先在 store/API 边界和高频页面中补类型，不做一次性全项目类型重写。
- 后端结构治理：
  - 已清理 `admin.js`、`admin-bag-routes.js`、`admin-farm-resource-routes.js`、`admin-public-info-routes.js`，这些文件应保持 0 个 `_v###`。
  - 大型服务/模型仍需逐步拆分：`models/store.js`、`core/worker.js`、`models/user-store.js`、`services/activity.js`、好友/农场/仓库相关服务。
- 功能面核对：
  - 新增或恢复功能时，确认它是可见、隐藏、内部还是休眠。
  - 检查是否还有后端存在但前端无入口、且未记录状态的能力。

# 接力约定

- 新对话先读本文件，再读相关源码；不要凭记忆改。
- 每次只选一个明确模块推进：先读当前实现，必要时对照本机旧版参考副本，再小步修改和验证。
- 手工编辑使用 `apply_patch`；不要回滚用户或其他过程留下的无关改动。
- 后端改动后至少跑 `node --check` 对触碰文件；拆/改路由时再跑 `node -e "require('./core/src/controllers/admin'); console.log('backend require ok')"`。
- 前端改动后至少跑 targeted `npx eslint ...`；影响页面/组件结构时跑 `cd web && npm run build`。
- `@vueuse/core` Rollup pure-comment warning 是已知非阻塞警告；UnoCSS 拉取 Google web fonts 超时也可能在网络不稳时出现。构建退出码为 0 即可记录为通过。
- 遇到中文显示异常，先用 `node -e "const fs=require('fs'); console.log(fs.readFileSync('path','utf8'))"` 确认真实内容。
- 不把全站 lint、全站格式化、全站类型改造作为默认目标；只有用户明确要求或分阶段收敛到位后再做。
- 要记得及时更新本文件

## 2026-07-06 TSDK / ACE 修复

- 已对官方 `game.js` 完成关键静态去混淆：官方调用为
  `SdkInitEx(3167, 0)`；`AnoUserLogin(0, openId)` 仅维护账号身份。
- 官方网关 Token 来自 `AceManager.randomStr()`，格式为 64～127 个字母数字字符
  加 `=`，不是 `_generate_token` 返回的 24 字符 hash；登录后还会优先消费一次
  `_get_encrypted_init_info`，对应抓包里首条 `AllLands` 的特殊长 Token。
- ACE 生命周期已按官方封装拆分：5 秒处理接收队列和轮询上报、25 秒 TSDK
  heartbeat、30 秒速度检测、150 秒状态上报、180 秒函数检查。
- 官方 20260706 抓包确认：登录和好友操作 Token 均符合随机格式；4 分钟后仍能
  Enter、PutWeeds、PutInsects、Farming，说明持续有效依赖 ACE 状态而非固定 Token。
- `core` 定向 ESLint 通过，6 个离线测试通过；仍需使用测试账号完成至少 5 分钟
  在线好友操作验证后才能确认服务端链路完全恢复。
- 活动中心已替换为“心许千灯星垂野”：接入主活动 `2026072700`、观星礼录
  `2026072701/cmd 21`、星砂商店打开 `2026072702/cmd 7`、兑换
  `2026072702/cmd 1`、千星游记和节令小札；可展示并领取二十八星宿奖励，星砂商店
  展示 18 项商品、协议映射名和星砂余额，并支持装扮及化肥兑换。
- 已将本轮活动更新沉淀为
  `core/docs/activity-update-runbook.md`，并新增
  `npm run inspect:activity-har -- <HAR>` 脱敏检查命令，后续活动按“完整抓包、协议表、
  官方资源、种子/植物/果实映射、分层接入、离线与在线验收”流程更新。
- 偷菜作物白名单（账号级）：新增 `stealWhitelist`，非空时只偷列表内 seedId
  对应的作物，空数组保持原“全偷”行为；白名单模式下不再参考植物黑名单。
  后端 `store.getStealWhitelist/setStealWhitelist`、`friend-land-analyzer`
  过滤点、`GET/PUT /api/steal-whitelist` 已接线；前端新增
  `StealWhitelistPanel`（策略设置页可搜索、全选当前、清空、保存），
  测试见 `core/test/steal-whitelist.test.js`。
- 修复账号级配置读取：`getUserState()` 返回的对象缺少 `accountId` 字段，
  导致所有 `userState.accountId` 为 `undefined`，账号级配置（植物黑名单、
  偷菜白名单、好友静默时段、暂停）一直静默退化成兜底值——实测白名单未含
  非洲菊（seed 20104）却仍被偷取。改为在 `getUserState()` 内按需从
  `FARM_ACCOUNT_ID` 补齐（worker 在 require 之后才写入该变量，不能在模块
  加载时固化），并新增断言覆盖。
- 偷菜日志补全结论：此前只记录成功，无法区分“被作物规则跳过”和
  “去偷但没偷到”。`analyzeFriendLands` 现在把被白/黑名单丢掉的
  地块记入 `stealSkipped`（含 landId、seedId、作物名、reason），
  三条偷菜路径分别写 `steal_skipped`（规则跳过）、`steal_blocked`
  （预检查不允许）、`steal_failed`（请求被拒）、`steal_partial`（部分成功）。
- 修复“不登录 → 立即登录无效”：点“不登录”会写 `autoLogin=false` 并停
  worker，而微信账号的“立即登录”走 `/relogin` 只刷凭证，随后的
  `restartWorker` 被 `worker-manager` 的 `autoLogin===false` 静默拦掉，
  接口仍返回 `ok:true`，面板因此误报“直接登录成功”。现在 `/relogin`
  在刷新前解除该标记，刷新失败则回滚，避免没上号却留下会自动拉号的状态。
- 2026-10-25 跟进微信小游戏 76 版包（`75` → `76`）：`tsdk.wasm` 从
  `1a9416db…`(161133B) 换到 `9c8b1ca0…`(161135B)，`acesdk.wasm.br` +4650B，
  `_subpackages_main_/game.js` +50660B，另有 4 个资源清单 json 改名。
  对应提交：`089428c` 跟到 `v3.9.0.1792565883`、`8191747` 补七种森野作物阶段
  贴图（`Crop_21`、`524`~`529`）、`8a2c29b` 登记三个黄金果实
  （1040527 甜橙、1040528 红柚、1040021 可可豆）、`18c0dbe` 客户端版本
  `1.13.0.5_20260723` → `1.15.1.4_20261021`。仓库内 wasm 与包内文件
  逐字节一致，`EventPlants`/`EventItems` 对应条目齐全。
- 2026-10-25 又发生一次工作区文件丢失：`.git` 只剩 `ORIG_HEAD`/`objects`/
  `packed-refs`/`refs`，`HEAD`、`config`、`index`、`logs` 缺失，导致 git 报
  `not a git repository`；同时 `web/`、`docs/`、`scripts/`、`core/docs/`、
  `core/Dockerfile`、`core/client.js`、`core/capture-server.js`、
  `core/eslint.config.mjs` 共 192 个文件消失，`core/data/` 与 `node_modules`
  一并丢失。`objects` 完好（40MB pack），已重建 `HEAD`/`config`/`index`
  并用 `git restore` 恢复全部文件，`git fsck` 无损坏。`core/data` 与
  `.git/logs` 不可恢复。与 09:28 那次 `rm -rf core` 不同，本次保留了
  `objects`，更像选择性删除或安全软件隔离。
- 2026-10-25 数据目录迁到仓库外：`.env` 的 `FARM_DATA_PATH` 由 `./core/data`
  改为 `../data`（即 `docker-compose.yml` 默认值），避免仓库被误删时连带
  丢失账号、日志和配置。改时 `core/data` 已为空，无迁移成本。
- 2026-11-01 跟进微信小游戏 77 版包（`76` → `77`，包目录 mtime 10-31 22:32）：
  客户端版本 `1.15.1.4` → `1.16.0.5`，proto 标记 `20261001` → `20261028`。
  `tsdk.wasm` 换到 `3d564429…`(161072B，比 76 少 63B)，版本
  `v3.9.0.1793442738`；`inspect:tsdk` 判定 imports/exports/dataSegments
  三项全兼容。`acesdk.wasm.br` +27818B（项目不引用）、
  `_subpackages_main_/game.js` +343549B、`subContext.js` +144B、
  `__APP__/game.js` +74B，4 个资源清单 json 再次改名。
- 2026-11-01 77 版新增玩法（主包枚举，项目侧已跟进土地品质）：
  变异效果表新增 `25:"藏品"`；装扮分类 `0:无,1:装扮,2:活动` 新增
  `3:藏品`；新增 `{0:无,1:摆件}`、`{0:无,1:藏品}` 两个枚举；
  土地品质名由 `1:普通 2:红色 3:黑色 4:金色 5:紫晶` 扩到
  `6:蓝晶`。物品 `type` 表出现 35 → 藏品（项目 ItemInfo 目前只到 19）。
  另有新增文案“盆栽”“点赞”“展示”“地块”“功能”。
- 2026-11-01 土地品质 6 级补齐：`farm-fertilizer.js` 与
  `farm-land-analyzer.js` 的 `getLandTypeByLevel` 原本只映射到 5，
  6 级会落回 `normal`（前端显示“普通地”、施肥按普通地过滤）。
  现新增 `6 → blue`／“蓝土地”，并把 `ALL_FERTILIZER_LAND_TYPES`、
  `DEFAULT_FERTILIZER_LAND_TYPES`、前端 `fertilizerLandTypeOptions`
  与 `allFertilizerLandTypes` 一并补上 `blue`。依据是 77 版主包的
  土地品质名表，6 级土地尚未在本机账号出现，需上线后复核。
- 2026-11-01 发现 16 个官方新作物资源但未登记：对比 plant bundle 的
  `config.24e45`（10-15，76 版时期）与 `config.84b95`（10-31，77 版时期），
  资源从 249 个增到 265 个，新增 `Crop_40 374 381 397 398 399 457 530
  1080 1082 1084 1096 1097 1099 1100 1111`，且每个都有完整阶段
  （`Seed` + `2`~`6`），不是补图。按 `Crop_N → seed_id = 20000+N` 的既有
  规律对应 `20040 20374 20381 20397 20398 20399 20457 20530 21080
  21082 21084 21096 21097 21099 21100 21111`，`Plant.json`（254 条）与
  `EventPlants.json` 对这些 seed 全部无记录。**未擅自登记**：名称、生长
  阶段时长、果实数、占地大小（`size`）都需要官方 Plant 配置行，资源清单
  推不出来。待账号凭证恢复后通过游戏接口核实再补，补时须同时确认 2x2
  作物的 `size: 2`。
- 2026-11-01 第三次工作区文件丢失（`.git` 目录 mtime 10-28 09:06）：`.git`
  再次只剩 `ORIG_HEAD`/`objects`/`packed-refs`/`refs`，`HEAD`/`config`/
  `index`/`logs` 缺失；`core/`（2263 文件）、`docs/`、`scripts/`、
  `web/src`、`web/public` 共 2268 个文件消失，`node_modules` 又一次残缺。
  `objects` 完好（43MB，两个 pack），已按上次同样流程重建 `HEAD`/`config`/
  `index` 并 `git restore` 全部恢复，`git fsck` 无损坏，HEAD 仍停在
  `6ce35f9`，没有丢提交。这次**仓库外数据目录（`../data`）保住了**
  `accounts.json`，上次把 `FARM_DATA_PATH` 迁出仓库的决定验证有效。
  三次丢失的共同点：`objects`/`refs`/`packed-refs` 都保留，丢的恰好是
  `HEAD`/`config`/`index`/`logs` 这类单文件，以及成批的源码目录。仍无法
  定位肇事进程，建议查 Windows Defender 保护历史、云同步客户端冲突记录、
  以及第三方清理工具的定时任务。
- 2026-11-01 77 版 TSDK 在真机账号上验收通过：扫码后日志输出
  `ACE 初始化成功：v3.9.0.1793442738，耗时 17ms`、`ACE 用户身份已绑定：初始化
  凭据长度 112`、`登录成功: others (Lv28)`、`ACE 上报成功：发送 51 字节，回灌
  0 字节`。说明 `3d564429…` 这份 wasm 的导入导出表和 22 个宿主函数约定都对，
  可以留在仓库，旧版 `v3.9.0.1792565883` 待下次更新时再清。
- 2026-11-01 本机账号实测数据（供后续核对）：21 块地（15 已解锁 + 6 未解锁），
  `level` 全部为 1，`landType` 全部 `normal`，因此**没有高级土地**，
  6 级“蓝晶”映射无法实测，仍属按客户端表预防性补全。好友 3 位。
  偷菜白名单继续生效：`载酒生活玩家: 跳过偷菜 1 块（不在偷菜白名单：黄豆）`。
- 2026-11-01 发现两处待处理数据缺口（都不影响主流程）：
  1. 背包出现未登记物品 `1042254`（count 10），面板显示“物品1042254”。
     按黄金果实 `104XXXX → gold/Crop_XXXX` 规律（已登记 1040516→Crop_516、
     1041625→Crop_1625、1045995→Crop_5995 均吻合）应为
     `gold/Crop_2254` → 植物 `1022254` / seed `22254` / 普通果实 `402254`；
     `Crop_2254` 在 plant config 里阶段齐全（Seed + 2~6，且有 gold 版），
     但 `Plant.json`、`EventPlants.json`、`EventItems.json` 均无该 ID。
     缺名称与生长数据，未擅自登记。
  2. `daily_share` 领取报 protobuf 解码越界
     `index out of range: 39 + 10 > 39`（`services/share.js` 的
     `ClaimShareRewardReply`），今日分享礼包因此未领到
    （`/api/daily-gifts` 里 `daily_share` `doneToday=false`）。其余每日
     礼包均 `doneToday=true`。`corepb.Item` 的 field 5（`Any detail`）和
     field 100（`ItemShow show`）在 proto 里是注释掉的，需要在复现时抓原始
     reply 字节再判断是新增字段还是字段类型变化，尚未改动 proto。
- 2026-11-01 首次领分享奖励的解码越界已定性：奖励实际发放成功，只是回包解析
  失败导致 `doneToday` 没置位。重建容器后重试直接命中“今日分享奖励已领取”，
  六个每日礼包全部 `doneToday=true`。已给 `ClaimShareRewardReply` 加解码失败
  时的原始字节 hex 日志（`services/share.js`），下次再现能直接比对 proto，
  在此之前不再猜字段。
- 2026-11-01 观察到新服务端业务码 `1000020`：好友巡查里
  `CheckCanOperate` 对除虫(10006)/浇水(10007) 返回该码，2026-09-28 加的
  诊断记录后兜底放行，实际操作成功（`巡查完成 → 除虫1/浇水1`），属既有兜底
  逻辑正常工作，非新问题。
- 2026-11-01 背包物品 `1042254` 的展示字段只有
  `show{field:4,wire:2,5字节}`，`bag-item-evidence` 判为
  `show_without_verified_name`。5 字节不足以还原名称，面板仍显示
  “物品1042254”；需在游戏内背包直接读取该物品显示名才能登记。
- 2026-11-01 微信小游戏包更新到 **78**（目录 mtime 11-01 15:14，
  `%APPDATA%/Tencent/xwechat/radium/users/76f09fde2b0ad89cff521b204fa72fe9/
  applet/packages/wx5306c5978fdb76e4/78`），解包产物在 `D:\tmp\wx78`，109 文件。
  - `tsdk.wasm` 161072 → **161112 B**，SHA-256
    `0b7e8717f8c8c0f5c61da0c67e169b3f4df9d07f9d37a95a4af3e392db82900f`；
    `inspect:tsdk` 提取新版本 **`v3.9.0.1793451777`**，imports(22)/exports(61)/
    dataSegments(17) 与 77 基线完全一致，结构兼容三项全 true。
  - 客户端版本 `1.16.0.5` → **`1.16.1.6`**，按目录 mtime 记作
    `1.16.1.6_20261101`（与 77 的 `_20261031` 同口径，日期取包目录 mtime）。
    proto 常量 `2026101300` 两版相同，未变。
  - **没有新玩法**：主包与 77 只差 42 字节，且差异段是 ACE 混淆变量名重排
    （`I,A,B,q,…` → `A,I,q,_,B,…`）与加密常量换值；中文串集合 77/78 均为
    305 个，新增 0 移除 0。`__APP__/game.js` 同理（+191 B 纯重排）。
    因此 77 版新登记的藏品/摆件/点赞/蓝晶土地无需再改。
  - 已更新 `tsdk-runtime.js`（版本/哈希/`wasmPath`）、`config.js`、
    `AdminSystemPanel.vue`、`useAdminSystemConfig.ts` 与两份 TSDK 文档；
    `device-protocol.test.js` 的 Referer 断言改为 `1.16.1.6`。
- 2026-11-01 78 版同样做了一次在线验收：容器重建后日志输出
  `ACE 初始化成功：v3.9.0.1793451777，耗时 14ms` → `登录成功: others (Lv28)`
  → `ACE 上报成功：发送 51 字节`。关键回归 64/64、`tsdk-runtime` 5/5 全绿，
  新 wasm 161112 B 与包内一致。上一个版本 `v3.9.0.1793442738` 按手册保留。
- 2026-11-01 **第四次仓库文件丢失**（约 15:15 之后）：`core/`、`docs/`、
  `scripts/` 共 **2271 个文件**消失，`node_modules` 内容同时被清空。
  与前三处不同，这次 `.git` 是**完整**的（`HEAD`/`config`/`index`/`logs`
  都在，只丢了工作区），`git restore .` 一次全部恢复，`git fsck` 无损坏，
  HEAD 仍是 `bacfdd7`。`node_modules` 需重新 `pnpm install`（746 包）。
  四次事件的共同点仍是"成批目录被清空、`.git` 对象库毫发无伤"，
  没有一次是 git 自身操作，需继续查外部进程。
- 2026-11-01 收菜延迟核查（用户提问）：自己收获走独立定时器
  `own_harvest_guard`，成熟时刻取自服务器 AllLands 的 `mature_at`，
  在 `成熟 + 30~80ms`（`OWN_HARVEST_ACT_DELAY_MS`）直接收缓存地块，
  不额外请求 AllLands，**延迟 ≈ 30~80ms + 一次 RTT**。免打扰、断线退避
  （180ms→30s 六档）、请求预算（Harvest 不在白名单，受 60s/80 总量约束）
  都会叠加延迟，但本机三项免打扰配置全为 false，不受影响。
- 2026-11-01 **修掉一个真实的收菜延迟边界**：`runFarmOperation` 先取
  AllLands 再种植，快照里没有新作物的成熟时刻；若这批地是全空，
  `lastNextMatureDueAtMs` 为 0，`idleNapMs` 走 `horizon<=0` 分支随机睡
  **1~120 分钟**。牵牛花（3h53m）不受影响，但 `Plant.json` 里有 9 种作物
  短于 2 小时（白萝卜 1m、胡萝卜 2m、大白菜 5m、大蒜 10m、大葱 20m、
  水稻 40m、小麦 1h、玉米 1.3h、鲜姜 1.7h），会被睡过成熟点。
  修复用种植回包自带的 `LandInfo`（`PlantReply.land`，含成熟阶段
  `begin_time`）立即刷新日程，**零额外请求**：`plantSeeds`/`plant2x2Seed`
  累积 `lands`，经 `plantFromBagSeeds`/`plantFromShop`/
  `plantPrioritized2x2Crops`/`autoPlantEmptyLands` 逐层透出，
  `runFarmOperation` 里的 `reconcileOwnMaturityFromLands`
  （原 `reconcileOwnMaturityAfterHarvest` 泛化，多一个 `source` 参数）
  消费后 `publishOwnMaturitySchedule('plant_reply')`。
  新增 `test/plant-maturity-refresh.test.js`，已验证修复前失败、修复后通过。
- 2026-11-03 **第五次仓库文件丢失**：`core/`、`web/`、`docs/`、`scripts/`
  再次成批消失（2272 文件），`node_modules`（含 `core/node_modules` 符号链接层
  与 `.pnpm` 内容）同时被破坏。这次连 `.git/HEAD`/`config`/`index` 也丢了，
  回到第一~三次的形态；`objects`/`refs`/`packed-refs` 完好。
  恢复按 runbook：写 `HEAD` → 重建 `core.*`/`remote.*`/`branch.*` 配置 →
  `git reset` → `git restore .`，随后 `rm -rf node_modules` 重装 746 包。
  `git fsck` 只有既有 dangling commit。
- 2026-11-03 微信小游戏包更新到 **79**（目录 mtime 11-03 20:27），
  解包产物 `D:\tmp\wx79`，109 文件。
  - `tsdk.wasm` 161112 → **160942 B**，SHA-256
    `f556ab0bae274d3e600b6505934394fcf5f4d9edc9fd3db3a42764785fc17cfd`；
    `inspect:tsdk` 提取 **`v3.9.0.1793626351`**，imports(22)/exports(61)/
    dataSegments(17) 与 78 基线完全一致，结构兼容三项全 true。
  - 客户端版本 `1.16.1.6` → **`1.16.2.7`**（`assets/resources/import/27/
    270bcfa0-….d8110.json` 的 `version` 字段，两版仅此一处不同），
    按目录 mtime 记作 `1.16.2.7_20261103`。
  - **没有新玩法**：中文字符串集合（2~8 字，js/json 全扫）78/79 均为
    **443 个，新增 0 移除 0**，与 77→78 时的 305 个口径不同但结论相同。
    77 登记的藏品/摆件/点赞/蓝晶土地无需再改。
  - 已更新 `tsdk-runtime.js`、`config.js`、`AdminSystemPanel.vue`、
    `useAdminSystemConfig.ts`、`device-protocol.test.js` 与两份 TSDK 文档。
    `pnpm build:web` 通过，回归 97/97。
- 2026-11-03 **背包未登记物品解决**（用户在面板看到
  `bag contains items missing from local item index: 1041435×4, 1042254×2`）。
  查证过程与结论：
  - 图鉴**协议**（`illustratedpb.proto` 的 `GetIllustratedListV2`）只回
    `seed_id`/`tier`/`unlock`/`reward_score`/`harvest_count`，**没有名字**；
    项目 `decodeIllustratedReplyRaw` 的手动解码同样只有数字字段。图鉴给不出名称。
  - 图鉴**面板**的名字来自 `nong.me/data/plants-data.js`（在线，仅 **174 种**）
    + 本地 `Plant.json`（254 种），两者都没有这两个植物。
  - 微信 79 包与 `gamecaches` 里也搜不到植物名：包内 443 个中文串全是 UI 文案。
  - 真正的突破点是 `EventPlants.json`：**`1021435 森野柿子`早已登记**
    （seed 21435 / fruit 41435 / `Crop_1435`），缺的只是它的黄金变体。
    `1041435` 因此按现有 14 条同族规律正式登记为 `黄金·森野柿子`。
  - `1042254` 的植物 `1022254` 在所有配置（Plant/EventPlants/ItemInfo/
    EventItems/79 包/gamecaches/nong.me）中都**不存在**，没有官方 Plant 行，
    按约定不猜中文名。
- 2026-11-03 新增**黄金变异果实推导规则**（`gameConfig.js` `deriveGoldMutationItem`）：
  `1040000+X` ↔ 植物 `1020000+X`，名称取该植物名拼「黄金·」，资产
  `gold/Crop_X`，`type 17`、`sells 1005:6`。规律由 14 条已登记条目验证
  （1040021→森野可可豆、1040435→山丹丹、1040516→狗尾草、1045995→芦苇、
  1049004→泡泡棉花糖…）。植物未收录时只给「黄金果实{X}」占位名，
  **不编造中文名、不回写配置文件**；段外（<1040001、>1049999）不误判，
  未命中仍返回 `undefined` 以保持原语义。
  实测：背包喂入 1041435×4 + 1042254×2，未识别日志消失，
  真正未知的 `999999` 仍照常上报（检测未被削弱）。
  新增 `test/gold-mutation-item.test.js`（6 条）；`seed-footprint-repair`
  的变更守卫白名单按设计补入 `1041435`。回归 126/126。
- 2026-11-04 微信小游戏包更新到 **80**（目录 mtime 11-04 16:46），
  解包产物 `D:\tmp\wx80`，109 文件。
  - `tsdk.wasm` 160942 → **161040 B**，SHA-256
    `41e5e9c01e8168e2caeaefcbff346252edfbed4e693b88fcae041f2eb3bffc87`；
    `inspect:tsdk` 提取 **`v3.9.0.1793763796`**，imports(22)/exports(61)/
    dataSegments(17) 与 79 基线一致，结构兼容三项全 true。
  - 客户端版本 `1.16.2.7` → **`1.16.3.8`**（`assets/resources/import/27/
    270bcfa0-….d8110.json`，两版仅此一处不同），按目录 mtime 记作
    `1.16.3.8_20261104`。
  - **仍然没有新玩法**：中文字符串集合 79/80 均为 **443 个，新增 0 移除 0**。
    77 登记的藏品/摆件/点赞/蓝晶土地无需改动。
  - 已更新 `tsdk-runtime.js`、`config.js`、`AdminSystemPanel.vue`、
    `useAdminSystemConfig.ts`、`device-protocol.test.js` 与两份 TSDK 文档。
    `pnpm build:web` exit=0，回归 126/126，lint 无 error。
- 2026-11-04 **80 包真机验收通过**（容器重建：`docker compose build` →
  `up -d`，镜像 `qq-farm-bot:latest`）：
  - `ACE 初始化成功：v3.9.0.1793763796，耗时 15ms`；`ACE 用户身份已绑定：
    初始化凭据长度 112`；`登录成功: others (Lv34)`；`ACE 上报成功`多次
    （51 字节 / 27~34ms）。唯一 warn 是既有的「TSDK 小程序完整性校验在
    Node.js 下不可用」降级。
  - 农场循环正常：`收获18 / 铲除18 / 种植21`，随后 `[虫:1 水:1 升:3 长:21]`；
    好友巡查 3 位（除虫1/浇水2）；连领 3 个任务；`CheckCanOperate`
    预检查仍是已知的 `1000020` 兜底放行，无其他 error。
  - **成熟日程修复真机确认**：`/api/lands` 返回种植后的
    `matureInSec: 14214` / `totalGrowTime: 14400`（天香百合 4 小时，
    已过约 3 分钟），说明 `plant_reply` 回灌日程生效。
  - **黄金果实识别真机确认**：`/api/bag` 33 种物品、104 段全部有名字，
    `bag_unclassified_item` 告警 **0 条**。除已登记的 15 条外，推导规则
    还救出 6 个此前从未报告过的果实且名字全部对上真实植物：
    `1040154 黄金·月桂花`(x35)、`1040251 黄金·鹭草`(x20)、
    `1041251 黄金·紫玫瑰`(x20)、`1040256 黄金·石竹花`(x10)、
    `1040186 黄金·米兰`(x8)、`1040133 黄金·凤仙花`(x7)。
    `1042254` 现存 10 个，显示占位名 `黄金果实2254`（植物 1022254 仍缺失）。
  - **土地映射实测**：现共 24 块地 = 4 块 `level 2` 红土地（lv2→`red`/
    「红土地」与游戏一致）+ 17 块 `normal` lv1 + 3 块 lv0 未解锁。
    `maxLevel: 6`。此前记录的「21 块地全 level 1 普通地」已过时。
    账号已从 Lv28 升到 **Lv34**，金币 1293097。
- 2026-11-04 **官方图鉴自身也有 21 条未命名条目**（`/api/illustrated`
  共 219 条：tier1 154 / tier2 27 / tier3 32 / tier4 6）。其中 21 条
  名字就是占位形式 `果实XXXX`，且 ID 与「16 个待登记新作物」完全吻合
  （40374/40381/40397/40398/40399/40457/41080…）。
  **结论：这些作物在游戏官方图鉴里也没有名字**，属于官方尚未配名的
  未上线内容，因此本项目不登记、只给占位名是正确行为，不是数据缺口。
  `1042254`（果实 42254、tier 3、`unlocked: true`）同样在此列 ——
  图鉴能查到该条目但名字也是 `果实42254`，游戏内同样看不到中文名。

- 2026-11-09 **偷菜预检查用错操作号（10004=放虫）导致连续误报 `steal_blocked`**：
  线上日志中「银谷签文纸片人」24 块枇杷被连续十余次记「跳过偷菜 24 块
  （服务器预检查不允许操作）」，其间夹一次 `friend_precheck_failure
  category=transport operationId=10004`，紧接着 `偷24(枇杷)` 全部到手，
  之后才出现 `steal_failed` 并回到 blocked——证明服务端从未禁止偷该作物。
  成因：三条偷菜路径（巡查 `visitFriendForSteal`、帮忙顺带偷
  `visitFriendFor`、手动偷 `doFriendOperation`）的 `CheckCanOperate` 都传
  `0x2714`=10004，而 10004 在本仓库早已实证是**放虫**（`friend-operation-limits.js`
  与 `friend-operation-id-contract.test.js`）；放虫只在未成熟地块可行
  （`analyzeFriendLands` 的 `phase !== MATURE`），成熟恰是可偷时刻，于是
  「能不能放虫」几乎必然 false。另 `friend-orchestrator` 的偷菜循环限流
  也读同一个键，导致偷菜与放虫额度互相干扰。
  - 修复：新增 `STEAL_OPERATION_ID = 10008`（`OP_NAMES` 同步标为「偷菜」），
    三处预检查与四处 `canOperate` 全部改用该常量；`plantpb.proto` 的旧注释
    不再作为依据。
  - 同时修掉「偷过还反复进门」：`visitFriendForSteal` 里的 `hasStealSlot`
    读 `plant.steal_player` / `plant.steal_num`，proto 的 `PlantInfo` 没有
    这两个字段（只有 `stealable`、`stealers`、`stole_num`、`left_fruit_num`、
    `steal_intimacy_level`），解码后恒为 `undefined`，过滤从未生效。改为在
    `analyzeFriendLands` 用真实字段 `stealers` 剔除本人已偷地块
    （`stealSkipped.reason = 'already_stolen'`，日志写「本人已偷过」），
    三条偷菜路径一次性覆盖；字段缺省或 `myGid` 未知时一律放行，绝不凭空
    否认可偷。
  - 验证：`test/steal-whitelist.test.js` 新增 3 条已偷过滤断言，
    `test/friend-operation-id-contract.test.js` 新增操作号契约断言
    （禁止 `0x2714` 出现在偷菜预检查/限流里）。定向 115/115 通过；
    全量 1265 项仅 13 条既有 Windows 环境性失败（权限位与长耗时），
    与改动前基线完全一致。

- 2026-11-09 **预检查失败计数：日志去重不再连次数一起藏掉**。原实现
  `recordPrecheckFailure` 用进程级签名 Set 去重，同一签名只落一条明细，线上
  因此只看得见一条 `friend_precheck_failure`，实际兜底放行了十余次却不可见。
  - 计数在去重/上限之外照常累加：`precheckFailureTotal`（总数）、
    `precheckFailureCounts`（按签名计数）、`precheckFailureSinceSummary`
    （距上次汇总的增量）。明细的签名表上限 16 与日志总量上限 32 只限制
    “写多少行”，不再限制“数了多久”。
  - 新增 `friend_precheck_failure_summary` 汇总行：只在确有重复且距上次汇总
    ≥ 5 分钟时写，单次偶发失败不产生额外日志；带上 total / sinceSummary /
    distinctSignatures / intervalSec。
  - 新增 `getPrecheckFailureStats()`（`friend-api.js` 导出）给出不受日志
    节流影响的精确累计：`total`、`distinctSignatures`、`logLines`、
    `summaryLines`、`sinceSummary`、`lastSummaryAt`、`bySignature`。
    `stats.js` 的 `getStats` 把它作为 `precheckFailures` 字段挂进状态上报
    （惰性 require + try/catch，诊断故障不影响状态输出）。
  - 排查口径：**不要用日志行数估失败次数**，读 `getStats().precheckFailures.total`。
    脱敏要求不变：统计与汇总行均不含错误原文、好友 GID、账号身份。
  - 验证：`test/friend-api-precheck-diagnostic.test.js` 6 → 12 条，新增
    精确计数、单次不落汇总、封顶后仍计数、汇总按时间封顶、统计字段白名单、
    总数大于日志行数等断言；定向 96/96 通过，全量 1271 项仍是既有 13 条
    Windows 环境性失败。

- 2026-11-11 **通信预算拦截：先诊断再收口，修 `hasBudget` 与 `checkRequest` 判定不一致**。
  线上日志里 `请求被治理器拦截(budget_total/budget_method)` 刷屏，并连带
  `常规施肥：获取土地信息失败`、`系统检查失败: …AllLands`、`任务检查失败: …TaskInfo`。
  - **诊断出口**：`request-governor.js` 新增 `buildBudgetSnapshot()` 与
    `noteBudgetDrop()`，预算拦截时 60s 节流输出一条 `governor_budget_drop`，
    带 `windowCount/totalLimit`、近段拦截次数和窗口占用 Top N 方法。
    此前 `getRequestProfile().top` 虽然算好了占用明细，但全仓没有任何出口，
    只能看到"哪个请求被拦"，看不到"额度被谁用掉"。聚合告警
    （`governed_warn_aggregated`）回答的是入口维度，这条回答的是方法维度。
  - **真实缺陷**：`hasBudget()` 原来只查总量。Enter 已打满 `PER_METHOD_LIMIT`
    而总量只用了 30/80 时它仍返回 true，偷菜循环继续按 40-120ms 间隔派发，
    每次都被 `budget_method` 逐条拦下——这就是 `enter_steal 本段31次` 的机制。
    现在传 `serviceName/methodName` 时同时检查单接口限值。
  - **判定顺序必须与 `checkRequest` 完全一致**：豁免（白名单/`/Harvest|Steal/`/
    成熟抢收 urgent 窗口）先于总量。顺序写反会让抢收紧急窗口里总量已满时
    守卫误报"没预算"，把治理器本来放行的到点抢收链静默丢掉；
    `test/request-governor.test.js` 有专门用例锁这一条。
  - **按目标实际首发请求守卫**：`preEnter` 复用分支不发 `Enter`，真实瓶颈是
    `CheckCanOperate`。三处派发守卫统一用 `guardReusesPreEnter` 选择
    `PlantService.CheckCanOperate` 或 `VisitService.Enter`，并有源码级断言
    防止服务名/方法写反（本版开发中曾写反过一次）。
  - 守卫覆盖 `dispatchDueCacheStealTargets`、抢收快路径、摘要后主派发循环
    三处；巡田轮询（`watchlist_poll`）未加，因为会打穿
    `priority-watchlist-runtime.test.js` 的 vm 依赖面断言，另轮处理。
  - `resetForTest()` 补 `urgentModeUntil` 复位（原来会跨用例泄漏紧急窗口）；
    `governed-warn-aggregation{,-baseline}.test.js` 的 governor 桩补 `hasBudget`。
  - 验证：`test/request-governor.test.js` 14 → 25 条；定向 137/137 通过，
    全量 1149 项仍是既有 28 条环境性失败（缺 `@babel/parser`、
    `getStealWhitelist`、无 git 仓库的 `git ls-files`），与改动前一致。
- 2026-11-16 **第六次仓库文件丢失**（比前五次更彻底）：
  `.git` 整个目录消失，`core/`、`web/`、`docs/`、`scripts/` 一并被清空，
  只剩顶层 13 个文件（AGENTS.md / README.md / package.json / pnpm-lock.yaml /
  progress.md / docker-compose.yml / start*.bat / stop*.sh / .env / zcode.json）。
  - **没有丢工作**：remote 上最新是 `aa148c6`（11-11 20:09），比本地已知 HEAD
    `2c4b057`（11-03）领先 6 个提交，11-03 之后的工作全部推送过。
    本地 `progress.md` 与 remote 版本逐字节一致，确认无未提交内容。
  - 恢复方式：因目录被几个 `bash.exe` 进程占用（`Device or resource busy`），
    无法 `rm -rf` 后 clone，改为原地 `git init` + `git remote add` +
    `git fetch origin main` + `git reset --hard origin/main`，2467 文件到位。
    仅需保留 `.env`（gitignored）与 `.pi/picode.json` 两个本地文件。
    `pnpm install` 746 包 4.2s。
  - 六次模式：**成批目录被清空、git 对象库前四次从不受伤**。本次连 `.git` 一起没了，
    但 remote 完整所以零损失。数据目录 `../data` 六年一贯幸存，验证外迁决策正确。
- 2026-11-16 微信小游戏包更新到 **81**（目录 mtime 11-16 11:28），
  解包产物 `D:\tmp\wx81`，**129 文件**（80 包 109 文件）。79 已被微信清理，
  本次以 80 为对比基线。
  - `tsdk.wasm` 161040 → **161102 B**，SHA-256
    `8f338c01ceed85cae2eb0e2cd20815dec495f22e4b4b50fca2040fdd8a9e3cdf`；
    `inspect:tsdk` 提取 **`v3.9.0.1794737041`**，imports(22)/exports(61)/
    dataSegments(17) 与 80 基线一致，结构兼容三项全 true。
  - 客户端版本 `1.16.3.8` → **`1.17.0.3`**（`assets/resources/import/27/
    270bcfa0-….08c5a.json`），按目录 mtime 记作 `1.17.0.3_20261116`。
  - **这是首次出现真实新玩法**：新增子包 `_subpackages_mcboot_.wxapkg`
    （2.3M，15 文件）=「牧场（MC / Pasture）」。中文串 80: 427 → 81: **3823**，
    排除 mcboot 后主包仅新增 58 条且全部是牧场相关（动物名 + 轮廓发光 shader 参数）。
    动物阵容调整：移除 大象/海狗/猩猩，新增 考拉/豪猪/水牛/骆驼/蜜薯。
  - **牧场不需要适配**：mcboot 内 `rpc`/`sendMsg`/`SendMsg`/`Sync` 全部 0 次命中，
    主包无 `Pasture`/`Ranch`/`mcboot` 痕迹，项目 proto 7 个 service 无牧场。
    官方开发文档 §9 明确「当前所有数据均为客户端 Mock」（地块、种子背包、作物时长、
    种植/收获/铲除全部本地改数据）。详见 `core/docs/pasture-mc-analysis.md`。
  - **意外收获**：9 个 CCON JSON 里打进 **10 篇官方开发文档**（约 185K 字），
    含架构、ECS 分层、RPC 约定、时序、扩展指南。已解出到 `D:\tmp\mc-docs\`，
    结论与提取方法记在上述 docs。
  - 已更新 `tsdk-runtime.js`、`config.js`、`AdminSystemPanel.vue`、
    `useAdminSystemConfig.ts`、`device-protocol.test.js` 与两份 TSDK 文档。
    `pnpm build:web` 通过，回归 1151 项 1139 通过（12 项为既有 Windows 限制）。
- 2026-11-16 **奶茶热销中（S4）退役归档** → `core/archive/milk-tea/`。
  按运行时实测：营业期 10-15 ~ 11-14，结算期 11-15 ~ 11-16，
  最终截止 `endTime = 1794844799`（11-16 23:59:59）。
  - 移走 5 个核心文件 + 11 个奶茶测试 + 2 个依赖奶茶 store 的活动测试：
    `services/milk-tea-activity.js`（1401 行）、
    `controllers/admin-milk-tea-activity-routes.js`（154 行）、
    `gameConfig/MilkTeaActivity.json`、`proto/milk-tea.proto`（513 行）、
    `components/activity/MilkTeaActivityPanel.vue`（1111 行），
    以及 `stores/activity.ts` 第 614 行起的活动 store（625 行，单独存为
    `activity-store-milkTea.ts`）。合计约 −8200 行。
  - 切断 6 处运行时引用：Worker 三个 case、provider 三个转发、
    `activity.js` 的 require + 奶茶根专用解码 + 导出展开、`proto.js` 的
    proto 加载与三个 `MilkTea*` 类型、admin 路由注册、`Activity.vue` 面板挂载。
  - `stores/activity.ts` 只保留历史活动类型导出（供 9 个现存历史组件编译），
    文件头注明「无运行态逻辑，不应再新增活动到此处」。
  - `Activity.vue` 重写为「暂无进行中的活动」+ 保留 admin 的活动分析入口
    —— `AdminActivityUpdatePanel` 是在线发现未适配活动的唯一工具，不能丢。
    历史退役记录以泛称保留（测试对具体活动名有否定断言，写全名会触发失败）。
  - `Activity.vue` / `star-activity` / `weather-activity` 三个既有测试断言
    「已退役活动不得再出现在页面」，归档后需保留 `S3 萌宠` 字样作为退役标记，
    已按测试意图补注释。
  - `eslint.config.mjs` 加入 `ignores: ['archive/**']`：归档代码保留原样，
    不参与构建也不被现行风格的 `--fix` 回溯修改。
  - **保留未动**：`EventItems.json` 的 `1041 奶茶券` / `1042 宣传喇叭` 物品定义
    —— 背包可能还有存量，删掉会变成未识别物品。
  - ⚠️ 归档时发现一个**从未触发但有缺陷**的配置：`MilkTeaActivity.json` 的
    `announceSettle.startAt` 写成 `1795795200`（11-28），而官方公告与注释都是
    **11-15 00:00**（正确值 `1794672000`），偏差 13 天。导致 11-15~11-16
    结算期内 `timingOf()` 仍判 `phase='open'`，营业类操作不会被拦截。
    实测 11-16 12:02 服务端仍返回 `phase:"open"`（而规则原文写「结算期
    11-15 — 11-16」）。归档后该代码不再运行，缺陷与修复方法记在
    `core/archive/milk-tea/README.md`，恢复时必须先修。
  - 账号当时的剩余状态（按用户决定不清理）：未领工资 1 笔、分享奖励 0/3 已领
    （currentScore 105）、奶茶券 5947 张。官方规则称未领收益会在结算期结束后
    邮件补发，奶茶券需自行出售。
- 2026-11-16 归档后实测（容器重建，镜像含 81 TSDK）：
  `ACE 初始化成功：v3.9.0.1794737041，耗时 14ms` → `ACE 用户身份已绑定：
  初始化凭据长度 112` → `登录成功: others (Lv49)`；ACE 上报 51 字节/27ms。
  `grep -ic "milk.?tea|奶茶"` 日志 **0 条**，无 error 级别日志，
  `/api/activity/milk-tea` 返回 **404**（路由已移除，符合预期）。
  `Activity.vue` 重写后构建通过，农场循环正常（`[草:3 虫:1 水:3 长:24]`）。
- 2026-11-16 **发现新活动「故友重逢」（2026111800 族）**，来自
  `/api/activity/update/status` 的 `unknownActivityIds`：
  - `2026111800`（根，type 1）、`2026111801`（子，type 11，uid `FriendRecallUI`）
  - 时间 **2026-11-16 10:00 ~ 11-23 23:59:59**；当前 `enabled: false`（未开放）
  - 规则：①召回老友，成功回归可领礼包，活动期最多 10 份；②浇水/除草/除虫等
    社交互动有概率掉落「重逢礼包」，活跃农场主每日上限 10 次（0 点重置），
    回归农场主 15 次；③成功回归进 30 天召回冷却期；④未领奖励活动结束后邮件补发
  - 另含回归者视角的「回归福利」（`buffTips`）：经验加成、buffList 1001 经验提升
  - **暂不适配**：`enabled: false` 且扫描器自评 `requiresProtocolSample: true`，
    没有 GetGroup 回包就无法确定 RPC 与字段，按项目约定不猜 proto。
    活动开放后需重新扫描取样。
  - 奶茶 5 个节点（2026110100/101/102/103/104）仍在下发，`endTime` 11-16
    23:59:59，属正常收尾 —— 明日之后 `ActivityService.List` 不再下发根节点，
    代码侧已无入口可触发。
- 2026-11-16 **牧场（MC）源码深挖**（用户问：是新小程序还是功能模块）。
  - **是当前小程序 `wx5306c5978fdb76e4` 的分包，不是独立小程序**：
    `__APP__/app-config.json` 的 `subPackages` 明确登记
    `{"name":"mcboot","root":"/subpackages/mcboot/"}`，并列入
    `parallelPreloadSubpackages`（启动并行预下载）。包体
    `_subpackages_mcboot_.wxapkg` 2.3M / 15 文件。
  - **入口尚未接入**：主包与 main 子包的 `game.js` 里 `mcboot`/`Pasture`/`Ranch`
    全部 0 次，无 `loadSubpackage`/`loadBundle`；`mcboot.scene` 是**空场景**
    （字符串表只有 `node`、`scene`，无节点/相机/Canvas）；`config.eded6.json`
    的 `paths` 只有 1 个场景 + 11 篇文档，`packs`/`native` 全空。
    → 客户端把牧场预埋好了，玩家现在还进不去。
  - **真数据在远程缓存** `gamecaches/mcRes/`：144 个 JSON、6.5MB =
    57 个明文 Prefab/Scene + **35 个加密配置表**（`FSpk…` 前缀 base64，
    疑似 XXTEA，暂时不破解）。
    配置表名字暴露了远超文档的功能面：`MCAnimalMutation`（动物变异）、
    `MCEmployeeCfg`/`MCEmployeeSkillCfg`/`MCSalaryCfg`（雇员+技能+工资）、
    `MCRanchLabLvConfig`（实验室等级）、`MCMainCityLvConfig`（主城等级）、
    `MCRotationShop*`（轮换商店）、`MCItemTrait`、`MCCellUnlockCondition`、
    `MCRanchWeightTier`（体重分档）、`MCItemInfo` 984KB。
  - **Prefab 节点名**（`d[2]` 共享字符串表）还原出 UI：主界面
    `nodeHeadFrame/imgLevel/expBar/txtDiamond/txtGold/btnExit` + 文案
    「商城/仓库/商店/图鉴/回家」；好友操作面板
    `operateIcon_steal/help/wife`；回访列表 `nudgeBtn/visitBtn/nameplateBg`
    + 文案「当前暂无满足条件的好友/回访/打招呼/在你家/帮你照顾了农场4次」。
  - **重要修正**：文档里写的 `GetBag`/`GetBagTab`/`Sell`/`BuyGoods`/`AddFeed`/
    `LockItems` 等 RPC，在 `mcboot/game.js` 里**一个字符串都没有**
    （`sendMsgAsync`/`WebSocket`/`socket` 也全 0）。文档描述的是**接服设计方案**，
    代码是纯 Mock。将来真接服时这份 RPC 清单就是现成的适配表。
  - 玩法清单按 10 篇文档整理：种植闭环（牧草/小麦/番茄，种子→发芽→幼苗→小叶→
    抽穗/开花→成熟）、栏舍动物交互（拖拽 400ms 节流、一键收获/生产/偷取/清理、
    副产物 5 槽）、仓库（批量出售/锁定/红点）、商店（幼崽/饲料 + auto_add）、
    牧草机（自家投草/访客赠送/剩余可用时间）、建筑升级与地块解锁三段式、8 种建筑
    气泡 + 2 种动物气泡、任务（只用 task_type 4/5/6）、建筑编辑收纳。
    动物：考拉/豪猪/水牛/骆驼/蜜薯，幼崽→成长→成年，体重匀称/超重/极重。
  - 结论写进 `core/docs/pasture-mc-analysis.md`（含 35 表清单、Prefab 判定表、
    提取脚本、下次复查的 6 条命令）。
- 2026-11-16 **用户出示流传截图，修正牧场结论两处**。
  - **截图是真的**：`gamecaches/mcRes/1794799703727162.png`（1125×1076，
    瀑布+湖+草地）与截图背景完全一致；UI 图集（木质面板、「回归」图标、
    「友」按钮）也在缓存里。截图右下 `Version 1.17.0.3` 与 81 包一致。
  - **但截图来自更完整的版本**：截图文案「返回农场」在 81 包与全部缓存里
    **0 次**（mcRes 里同一位置是「回家」）；「待领取邮件」「总价值」也是 0 次；
    「天工作物」在 `mcboot/game.js` 的 89 个 UI 串里不存在。
    → 文案已从「回家」改成「返回农场」并新增天工作物收获开关，说明有更新的包。
  - **「入口未接」的判断是错的**：我原来靠 `grep mcboot|Pasture|Ranch` 扫主包与
    main 子包得 0 次就下结论，但同一方法对**已在运行的农场 bundle 同样返回 0**
    （`mainscene=0 extraRes=0 plant=0 animal=0 mcRes=0 internal=0 main=0`）——
    业务代码不写 bundle 名字面量，Cocos 从 `settings.assets.projectBundles`
    和资源路径推导。**该方法无法证明没有入口**。
  - **反而找到牧场已集成的证据**：`gamecaches/extraRes/17948013196100.json`
    （今天 11:55 下载）是设置界面，里面同时有「牧场」+`mcOneClickTG`+`mcBubble`：
    设置项文案为「**显示牧场建筑气泡**」和「**一键收获天工作物**」。
    设置界面给牧场留了开关，说明牧场已进入上线/灰度流程。
  - **截图没种地的原因**：该玩家等级仅 **2**（230/400）、栏舍 3/3、牧草机 1 级，
    是新号；地块受 `MCCellUnlockCondition` 约束（该表仅 208 字节，条目极少），
    新号未解锁属正常。不是「牧场没有种植」。
  - **顺带发现作物稀有度分阶**：「天工」与 S3 萌宠活动文案同文件出现，并在设置项里
    写作「一键收获**天工作物**」，同批文案还有「稀有种子系统」「普通稀有珍品天工作物
    完整新资源」「琉璃宝荷」「琉璃宝莲」「琉璃宝荷黄金」→ 作物按
    **普通 / 稀有 / 珍品 / 天工** 分阶。
  - 仍成立的结论：mcboot 数据全 Mock，`GetBag`/`BuyGoods`/`AddFeed` 等 RPC
    在 `mcboot/game.js` 里 0 次，无网络代码 → 自动化仍无从下手。
  - 已更正 `core/docs/pasture-mc-analysis.md`（新增第二节「入口判断的更正」、
    第三节「流传截图是真的但版本更新」，并把原入口小节降级为「数据仍是 Mock」）。
- 2026-11-16 **牧场开放，协议面反转确认 + 出适配规划**。
  - 用户报告牧场已能进。重新核查 81 包 `mcboot/game.js`（2.05MB）后**推翻早期「零协议纯 Mock」结论**：
    - 文件里有 **539 个 protobuf 消息 / 1937 个字段**，字段名全明文（`ranch_inst_id`、`animal_inst_id`、
      `grow_ready_at_ms`、`produce_ready_at_ms`、`can_harvest`、`can_feed`、`grass_blocked`、
      `can_deliver`、`delivering_until_ms`、`expected_harvest_sells`、`shelves[]`、`hazards[]`、`op_results`
      等），另有 42 个枚举 / 211 个成员。
    - **mcboot 自己不传输**（`wx.request`/`WebSocket`/`fetch` 全 0），但**构造完整 proto 请求对象**交给
      主包注入的网络模块（外部 dep `238`，其上调用 62 个方法索引）。请求如
      `{ranch_inst_ids, op, animals, shelves}`、`{host_gid, targets}`、`{ranch_inst_id, host_gid, hazard_ids}`。
    - **RPC 方法名/proto 消息名被 TSDK 字节码 VM 加密**：`globalThis._Аce_7716("<base64>",!1)(-1,[],{...},[void 0],void 0)()`。
      注意 `Аce` 的 `А` 是**西里尔字母**（`grep ACE` 匹配不到）、`_7716` 是每次构建随机后缀 —— 这就是之前
      三次「搜 RPC 名 0 次」的真正原因，**不是没有协议，是搜索方法失效**。
  - **早期「入口未接」的教训同样适用**：`grep mcboot|plant|mainscene` 在业务代码里全 0，因为 bundle 名不硬编码。
  - 尝试静态复现 `_Аce_7716`：函数体已完整提取（11019 字节，纯 JS 字节码 VM，99 条指令），
    已在 Node 装载成功，但 payload 依赖真实模块运行时环境，脱离游戏上下文进死循环 → **静态逆向不划算**。
  - **改为抓包路线**：`GateMessage.meta` 里 `service_name`/`method_name` 是**明文**（只有 body 被 TSDK 加密），
    项目已有 `npm run inspect:protocol -- <har> --decrypt-requests` + `_webSocketMessages` WS 帧支持 → 抓一次即可。
  - 产出 `core/docs/pasture-automation-plan.md`（规划，不写代码）：
    - 可零改动复用：`network.js`/`tsdk-runtime.js`/`crypto-wasm.js`/`ace-service.js`/`scheduler.js`/
      `daily-events.js`/`json-db.js`/worker 通道。
    - 需小幅修改：`proto.js`（加载）、`request-governor.js`（**预算要分池**）、`store.js`（automation 加组）、
      `worker.js`（加 pasture tick）、`data-provider.js`、`admin.js`、`menu.ts`。
    - 需新增：`pasturepb.proto`、`pasture-api.js`、`pasture-analyzer.js`、`pasture-orchestrator.js`、
      `pasture-visit.js`、`admin-pasture-routes.js`、`Pasture.vue` + `stores/pasture.ts`。
    - **语义 1:1 映射**：`can_harvest ↔ MATURE`、`produce_ready_at_ms ↔ phases[last].begin_time`（精确抢收墙钟）、
      `can_feed ↔ dry_num`、`hazards[] ↔ weed_owners/insect_owners`、`capacity-animal_count ↔ empty`、
      `ShelfLot.can_steal ↔ stealable`。
    - **`AnimalInst` 自带 `expected_harvest_exp`/`expected_produce_sells`** → 收益判断可直接从回包算，
      不依赖加密配置表（比农场的本地选种策略还简单）。
    - 阶段：0 抓包 → 1 只读 → 2 自家自动化 → 3 好友 → 4 面板。
  - 仍待办：**需要一份牧场抓包**才能开工阶段 1。
- 2026-11-16 **牧场协议抓包成功，proto 已落地并验证（阶段 0 完成）**。
  - 给内嵌抓包服务（`core/src/capture/`）加了原始流量落盘开关 `CAPTURE_DUMP_DIR`
    （默认关闭；JSONL 逐块记录 `{t,cid,host,dir,len,b64}`，`dir` = chead/c2s/s2c）。
    落盘只对 `captureHosts` 做 MITM，不影响原有抓包登录。
  - 环境：Windows 系统代理 `127.0.0.1:18000` + 自签根证书 `QQFarmCaptureRootCA`
    装入当前用户。用户操作一遍牧场，抓到 **1.4MB / 516 条消息**。
  - **协议面完全确认**：牧场 = `gamepb.animalpb`（AnimalService + RanchService）
    + `gamepb.homesteadpb`（HomesteadService + FeedMachineService）。
    10 个 RPC 全部拿到请求/响应结构：
    `GetRanchDetail` / `HarvestRanch` / `FeedAnimal` / `TriggerProduce` / `StealProduce`
    / `CleanAllRanch` / `GetRanchOpTimes` / `GetBuildingList` / `GetFacilityDetail` / `AddFeed`。
    通知：`FacilitiesNotify`（38 条）。
  - 新增 `core/src/proto/pasturepb.proto` + `core/src/proto/homesteadpb.proto`，
    字段名与 field number 经**两路交叉验证**：mcboot 静态提取的定义 + 真实回包解码，
    8 个响应全部解通（RanchInfo / AnimalInst / OpQuota / FacilityDetail / FeedMachineState）。
  - **两个实现坑（写进文档）**：
    1. **请求体加密、响应体明文**。请求要 `tsdkRuntime.decrypt()`，响应直接 decode。
       搞反会解出错位的 field number（曾解出 `field 1310`）。
    2. **WS 帧前面有 HTTP 101 响应头**，s2c 必须先剥 `\r\n\r\n` 之前的部分，
       否则分帧从错误偏移开始，整条连接全乱。
  - 实测数据：`RanchInfo{ranch_inst_id:10001, capacity:4, animal_count:4}`；
    `AnimalInst{animal_id:60002, stage:1, can_feed:true, expected_harvest_exp:360,
    expected_harvest_sells:[{id:1007,count:2160}]}`；
    `OpQuota{11003:100, 11008:20, 11009:10}`；
    `FacilityDetail{facility_inst_id:10002, name:"牧草机", facility_id:7001001, level:8,
    feed_machine:{capacity:99, current:72}}`。
  - **新发现**：牧场的道具 ID 空间与农场不同 —— `expected_*_sells` 里的 `id=1007`
    在农场 `ItemInfo.json` 里不存在（农场金币是 1001），属牧场专用道具，
    需 `MCItemInfo` 加密表才能拿名字。
  - **仍缺样本**：买动物/补栏、扩建 capacity、单个灾害处理、
    `op_id`（11003/11008/11009）与操作的对应关系、好友牧场完整链路。
  - 文档：`core/docs/pasture-automation-plan.md` 追加「抓包实测结果」附录
    （10 个 RPC 表 + 数据样本 + 两个坑 + 工具链用法）。
- 2026-11-16 **牧场自动化最小闭环落地（阶段 1+2）**。
  - 新增 `core/src/services/pasture-api.js`（10 个 RPC 收口，四个 service：
    AnimalService / RanchService / HomesteadService / FeedMachineService）。
  - 新增 `core/src/services/pasture-analyzer.js`（纯函数：RanchInfo → 可收获 /
    可收货物架 / 需投喂 / 灾害 / 草量 / 空栏 / 最近产物成熟墙钟）。
  - 新增 `core/src/services/pasture-orchestrator.js`（编排：收货架→收获→投喂→
    清理→补草；guard 含连接态、总开关、重入、农场收获让路）。
  - 新增 `core/src/services/pasture.js` barrel。
  - 修改 `proto.js`（加载 pasturepb/homesteadpb，注册 26 个类型）、
    `store.js`（`DEFAULT_AUTOMATION` 加 `pasture` + 四个子开关，白名单
    `ALLOWED_AUTOMATION_KEYS` 从默认对象动态派生所以自动生效）、
    `config.js`（`pastureCheckIntervalMin/Max` 20–30s）、
    `worker.js`（`nextPastureRunAt` + `runPastureTick` + unified tick 接入，
    含免打扰/自家收获让路/偷菜让路/nearest 计算四处同步）。
  - 新增 28 个测试全绿：`pasture-api.test.js` 10（payload 能被对应 Request
    类型 round-trip 解回，抓字段名错误/int64/结构错位）、
    `pasture-analyzer.test.js` 8（含 Long 对象、脏数据、空栏推算）、
    `pasture-orchestrator.test.js` 10（guard、细分开关、执行顺序、补草冷却）。
  - **同步修了 4 个既有测试的 sandbox**（`maturity-sentinel`、`friend-summary-
    backoff` ×2、`idle-protection`）：它们用 vm 抽 worker 源码跑，需要补
    `nextPastureRunAt` / `runPastureTick` 注入，否则 `ReferenceError`。
  - 全量回归：**1179 项 / 1167 通过 / 12 失败**，失败数与基线一致（均为既有
    Windows 限制：0600 权限、符号链接、并发抖动、`getStealWhitelist` 沙箱缺注入）。
  - **仍缺**：买动物补栏、扩建 capacity、单个灾害定点、好友牧场偷产物调度、
    面板入口、`op_id` 语义确认。详见 `core/docs/pasture-automation-plan.md`。
- 2026-11-16 **第二轮抓包：补栏 + 定点清理落地**。
  - 用户操作覆盖：买动物→放入栏舍、单点清理、进好友牧场（催生产/偷产物/返回）、重进游戏。
    抓到 2.0MB / 新增 3 个 RPC。
  - **`AnimalService.PlaceAnimal`**：`targets: [{ranch_inst_id, animal_id}]`，
    `animal_id` 是**种类号**（60001）不是实例号，服务端自动分配 slot。
  - **`RanchService.CleanRanch`**：`host_gid` + `hazard_ids`（packed repeated，实测 `[11]`），
    定点清理，与一键 `CleanAllRanch` 的区别就是能指名。
  - **`RanchService.StrokeAnimal`**：`host_gid` + `target{ranch_inst_id, animal_inst_id}`。
  - `StealProduce` 补全：可带 `target` 指定偷某只。
  - **买动物复用农场 `ShopService.BuyGoods`**（参数一致）。动物商店实测 16 种，
    `goods_id=10002↔item_id=60001 price=2` … `goods_id=10011↔item_id=60008 price=12672`，
    price 单位是 item 1007（牧场货币）。shop_id 无法从加密请求确定，
    `getAnimalShop()` 遍历候选 `[2,4,5]` 找含 60xxx 商品的店并缓存。
  - **gid 语义确认**：用 `Heartbeat` 交叉验证 → 自己 = `1284046759`
    （与 `PlayerLogin` 的 `basic.gid` 一致）；`1288674344`/`1233369866`/`1285654584`
    等都是好友。注意 `accounts.json` 里该账号记的 gid 是 `1288674344`（好友的），
    不影响运行（运行时取自登录回包）但会误导排查。
  - **修掉一个真 bug**：`isAnimalItemId()` 用 `Number(itemId)`，而 protobufjs 解 int64
    给的是 Long 对象 → `Number(Long)` = NaN → 动物商店永远匹配不到、补栏静默失效。
    改为 `toNum()`，测试补了 Long 断言。
  - 编排更新：清理优先走定点 `CleanRanch`（拿不到 hazard_id 才退回一键）；
    补栏固定「先背包后购买」，背包有动物绝不花钱；
    `pasture_buy_animal` 默认 **false**（买动物要花货币）。
  - 测试扩到 **42 项全绿**（api 17 / analyzer 8 / orchestrator 17），
    新增 `getAnimalShop` 缓存、Long 处理、定点清理优先、补栏两条路径等用例。
  - 全量回归 **1193 / 1181 通过 / 12 失败**（基线不变）。
  - 抓包环境已还原：系统代理恢复 `127.0.0.1:7897`（ProxyEnable=0，与抓包前一致）。
- 2026-11-16 **牧场面板 + 好友偷取收尾（功能闭环）**。
  - 后端：新增 `controllers/admin-pasture-routes.js`（`GET /api/pasture`、
    `POST /api/pasture/operate`，op 白名单），`services/pasture-visit.js`（好友偷产物）。
    `worker.js` 加 `getPasture` / `doPastureOp` 两个 case，`data-provider.js` 加映射，
    `admin.js` 注册路由。
  - **好友偷取无需门票**：农场偷菜要 Enter→分析→操作→Leave 四步，牧场
    `StealProduce` 直接用 `host_gid` 指名，一次请求。`pasture-visit.js` 因此很薄：
    拉好友列表 → 逐个 `GetRanchDetail(host_gid)` → 有 `can_steal` 货架就偷。
    护栏：开关默认关、单轮 ≤5 个好友、5 分钟冷却、单好友失败不影响其他。
  - `GetRanchDetail` proto 补 `host_gid = 1`（第二轮抓包确认好友场景出现过 8 个不同 gid）。
  - 分析器加 `buildPanelView()`：把 analysis 转成面板可渲染结构
    （汇总 + 动物列表含阶段名/倒计时 + 货架 + 灾害 + 空栏）。
  - 前端：新增 `stores/pasture.ts`（含账号切换丢弃过期响应）、`views/Pasture.vue`
    （汇总卡片/单项操作/动物网格/货架灾害空栏，20s 轮询，未连接不打接口），
    `menu.ts` 加「牧场」菜单项。`AutomationSettingsTab.vue` 加「牧场自动化」分组
    共 8 个开关，并同步 `useAutomationSettings` / `stores/setting.ts` /
    `DefaultPlanSettingsTab` 三处默认值。
  - 新增开关：`pasture_refill`（默认开）、`pasture_buy_animal`（默认**关**）、
    `pasture_steal`（默认**关**）。
  - **测试 51 项全绿**：api 17 / analyzer 12 / orchestrator 17 / visit 8 / routes 9。
    全量回归 **1214 / 1202 通过 / 12 失败**（基线不变）。
  - 前端 `vue-tsc --noEmit` 0 错误、`vite build` 成功（产物 `dist/assets/Pasture-*.js`）。
  - 面板动物名仍显示 `动物 #60001` —— 名字在加密的 `MCItemInfo` 表里。
- 2026-11-16 **抚摸接入编排 + 中文名调查结论**。
  - 用户实测：**抚摸（StrokeAnimal）会推进动物产出**。已接入编排，位置在
    「收获之后、投喂之前」。节流：同只动物 10 分钟、单轮最多 5 只、
    只摸 `mutation.strokable==true` 的。新增 `pasture_stroke`（默认开），
    分析器输出 `strokable[]`，面板加「抚摸」按钮 + 第 6 张汇总卡。
  - **中文名静态解不开**。`MCItemInfo`（984,593 B）是 `cc.TextAsset`，`text` 字段是
    `FSpk` 开头私有格式。穷举验证全部不成立：
    base64 直解（738371 B，%4=3 → 非 XXTEA）、单字节 XOR 256 种、单字节加减各 256 种、
    zlib/gzip/brotli × 偏移 0–32、TSDK `decrypt()`（输出变随机，非 TSDK 格式）、
    CCON 字符串表（u8/u16/varint 长度 × 偏移 0–40）。
    数据特征：熵 7.22、可打印 74%、256 种字节全出现、可打印段与高字节段交替。
    解析逻辑在客户端且字符串被 TSDK VM 加密 → 只能 hook 运行时。
  - **改为可填表**：新增 `core/src/gameConfig/PastureNames.json`，
    `gameConfig.js` 加 `getPastureAnimalName` / `getPastureFacilityName`。
    没填显示 `动物 #60001` 占位（不编造），填了立刻生效。
    已知设施名 `7001001=牧草机`（抓包 FacilityDetail.name 直接给了中文）。
  - 测试 67 项全绿（orchestrator 从 17 增至 21，新增抚摸四条用例）。
    全量 1218 / 1206 通过 / 12 失败（基线不变）。
- 2026-11-16 **牧场 28 个动物中文名全部拿到（不再需要人工填表）**。
  - 修正前面的错误结论「FSpk 解不开只能人工填」—— **方向错了**：
    名字不用从加密配置表挖，**商店接口给了 item_id + price，界面写着名字**。
  - **发现第二段 ID 空间**：之前只发现窝类 `60001-60016`，漏了
    棚类 `70001-70012`（第一次导出商品表时只看了前 8 条）。
    窝类 goods_id：10002-10007/10010-10011/10014-10015/10018-10019/10022-10023/10026-10027；
    棚类：10008-10009/10012-10013/10016-10017/10020-10021/10024-10025/10028-10029。
  - 三重验证：商店截图（名字+价格+窝/棚标签）× 抓包 ShopInfo（goods_id→item_id→price）
    × 28 项价格逐个吻合（窝/棚价格大量重复，如火鸡与羊都是 5640，靠顺序区分）。
  - 完整映射已写入 `core/src/gameConfig/PastureNames.json`（28 只动物 + 牧草机设施）。
    注意 `70001`（羊，动物）≠ `7001001`（牧草机，设施）。
  - FSpk 仍解不开（补充排除：base85、二次 base64、位旋转、2字节 XOR×65536、
    4字节 key 反推；并确认客户端无 XXTEA 常量、mcboot 无 atob/charCodeAt、
    mcRes bundle-script 只有 SpineSilhouetteGlow2、ShopInfo 无 name 字段）。
    但已不影响功能。
  - 测试 74 项全绿（analyzer 19），新增断言：28 个 id 全部返回真名不留占位、
    棚类 70001 与设施 7001001 不混淆。全量 1225 / 1213 通过 / 12 失败（基线）。
- 2026-11-16 **真机测试，抓出并修掉两个静态分析看不到的 bug**。
  - **bug1 proto 错位**：`HarvestRanchReply.field5` / `CleanRanchReply.field2` /
    `TriggerProduceReply.field3` 被我定义成 `repeated OpResult`，实际是「操作明细」
    （`{1:ranch_inst_id, 2:?, 3:animal_inst_id, 10:{...}}` 这种嵌套）。
    protobufjs 按 OpResult 解会错位，实测 `invalid wire type 7 at offset 33`，
    结果 `animals` 全丢、面板显示 0 栏位。**修法：这些 Reply 只保留 `ranches`**，
    其余交给 protobufjs 按未知字段跳过（代码里本来也没用到）。
    抓包 45 条响应复测：HarvestRanch 4→0、CleanRanch 1→0、TriggerProduce 1→0，总失败 0。
    回归测试把当时失败的 462 字节响应内联成 fixture。
  - **bug2 空闲防护饿死牧场**：`planIdleProtection()` 只用 `farmAt`/`helpAt`，
    牧场 20-30 秒一轮但农场要等 7 分钟 → 整轮暂停 7 分钟，牧场永远等不到。
    修法：加 `pastureAt` 参与 `Math.min`（只在有值时参与，保持向后兼容）。
    真机验证：`08:56:23 农场歇 18分` → `08:56:46 牧场就绪`，「重点防护」0 次。
  - 顺手修：`isAnimalItemId` 用 `Number(Long)` = NaN，改 `toNum()`。
  - 顺手修前端：`toast.add({type,message})` 签名错误（应为 `add(msg, type)`），
    `pnpm build:web` 报 4 个 TS 错误，已修。
  - 测试：牧场 76 项全绿；全量 1228 / 1216 通过 / 12 失败（基线）。
  - 环境：已 `pnpm build:web` + `docker compose build` + `up -d`，
    容器 healthy，`GET /api/pasture` 返回正常（中文名「鸡」显示正确）。
  - **待用户确认**：牧场当前 0/3 栏位（动物空），需放一只动物或开
    `pasture_buy_animal` 才能看到收获闭环。
- 2026-11-16 **牧场与农场全面对齐**（除牧场本身没有的功能）。
  - **牧场任务（新能力）**：牧场并非没有任务，而是与农场**共用 `TaskService`**，
    只需 `scene_id=2`（`GLOBAL_SCENE_ID_BIG_FARM`），任务类型 4/5/6
    （家园成长/每日/支线；农场是 1/2/3）。来源是 mcboot 里的官方文档《牧场任务系统》。
  - **scene_id 字段号用加密反推证明，不是猜**：农场 `TaskInfo` 请求 0 字节、
    牧场 2 字节 `e998`；TSDK 加密确定性且不变长 → `08 02` 加密得 `e998` 完全一致
    （`10 02`→`d498`、`18 02`→`0598` 均不符）。所以 `TaskInfoRequest { int32 scene_id = 1; }`。
  - 新增 `checkAndClaimPastureTasks` / `getPastureTaskSummary`；开关 `pasture_task`
    默认开且**独立于**农场 `task`；`getTaskInfo(sceneId)` 传 0 时 body 仍为空（零行为变化）。
  - **真机验证**：`GET /api/pasture/tasks` 返回「生产3次/完成1次生产/完成1次收获」等
    真实牧场任务（claimable 3），`POST /tasks/claim` 返回 `{"claimed":3}`，领完 3→1。
  - **推送触发**：`FacilitiesNotify` 之前被当「未识别推送」丢弃，现在解码分发
    `facilitiesChanged`，把下一轮 tick 拉到 1.5 秒内（3 秒去抖、好友牧场不叫醒自家）。
    推送只负责叫醒，决策仍以 `GetRanchDetail` 快照为准。
  - **间隔可配**：`intervals.pastureMin/Max`（默认 20/30 秒），进「策略设置 → 巡查时机」。
  - **首页**：概览新增「牧场」卡（栏位/可收获/待投喂/货架/牧草/可领任务 + 跳转），
    倒计时卡加「牧场」行（`nextChecks.pastureRemainSec`），60 秒轮询、切号立刻重拉。
  - **个人页**：`Personal.vue` 3 tab → 4 tab（我的农场/**我的牧场**/背包/任务）；
    面板抽成 `components/PasturePanel.vue`（结构对齐 `FarmPanel`）；
    侧边栏牧场项改 `showInNav: false`，路由保留给深链接。
  - **对齐缺口（有意不做）**：牧场**没有图鉴**（官方文档写明「图鉴等后置」，
    `IllustratedService` 只有作物/鲜花/树木）；**栏舍升级**无明文 RPC（TSDK VM 加密，
    无样本），按项目规矩不猜。
  - 测试：`pasture-task.test.js` 9 项，牧场全套 86 项全绿；
    验证过「删掉 scene_id 立刻挂 2 项，加回来 9 项全过」。
  - 前端 `pnpm build:web` 通过（补齐 4 处 `pasture_task`/`pastureMin` 类型与默认值）。
- 2026-11-16 **牧场真机闭环验证 + 修掉三个真 bug + 补运行策略**。
  - **闭环验证通过**（日志实录）：`买入并补栏 1 只动物（goods 10002，花费 2）` →
    `本轮操作：refill_slots` → `投喂 1 只动物` → `清理 1 个灾害（定点）` →
    `发现 1 个可领取牧场任务` → `领取(牧场每日): 清理1次牧场`。全自主，无人工介入。
  - **浏览器逐项确认前端**：概览页「牧场」卡（栏位/可收获/待投喂/货架/牧草/可领任务 +
    跳转）、倒计时「牧场」行（实时 00:00:09）、个人页 4 个 tab、
    「我的牧场」面板（含动物网格与牧场任务）、「策略设置 → 牧场策略」。
  - **bug1 `HarvestRanch` 被当成收货架接口**：真机日志「收货架 3 个」之后
    栏位 3/3 → 0/3，三只鸡全被收出栏。官方文档区分 `CollectProduce`（收副产品）/
    `HarvestAnimal`（收获出栏）/ `HarvestRanch`（一键收获）。
    **改为完全不调用**，只记录待收数量 —— `CollectProduce` 无 proto 样本，按规矩不猜。
  - **bug2 `TriggerProduce` 是「一键开轮」不是「开始生产」**：两次复现都是
    调用后产物进货架 + 动物整个消失。`MCOneKeyTriggerProduceOp.ts` 的注释正是「一键开轮」。
    **改为绝不自动调用**，并删除 `pasture_produce` 开关（前后端），去掉这条日志刷屏。
  - **bug3 面板看不到幼崽/成长中动物**：`buildPanelView` 只遍历三个**动作**分类，
    刚买的鸡（stage 1-2）不属于任何一类，整个从面板消失（`summary.animals=1` 但
    `animals=[]`）。改为遍历新增的 `allAnimals` 全量列表。
  - **bug4 概览页牧场卡首屏恒 0/0**：`refreshPasture` 卡了 `realtimeConnected`，
    首屏 WS 未连就 return。改为只看 accountId，并 watch WS 连上后补拉。
  - **bug5 `<Transition mode="out-in">` 卡死 tab 切换**：`Personal.vue` 切 tab 时
    按钮高亮变了但面板停在旧组件（加不加 `:key` 都一样）。去掉过渡层后四个 tab 正常。
  - **运行策略补齐**（需求 4 缺口）：新增 `pasturePreferredAnimal`（优先补栏动物，
    对应农场「优先种子」）与 `pastureStealWhitelist`（偷产物白名单，按货架 lot 的
    `animal_id` 判断，空=不限制，对应农场「偷菜白名单」）；新增
    `GET /api/pasture/animals`（28 种动物清单）与「策略设置 → 牧场策略」面板。
  - **能力边界（诚实记录）**：收获出栏代码路径正确（`can_harvest` → `HarvestRanch`）
    但要等动物自然产出；收副产品缺 `CollectProduce` proto；启动生产因语义危险不自动调。
    动物会自然进入 `producing=true`（抓包有此类样本），不调 TriggerProduce 也能等到。
  - 测试：`pasture-orchestrator.test.js` 27 项、`pasture-visit.test.js` 11 项、
    `pasture-analyzer.test.js` 22 项，牧场全套 **97 项全绿**。
    新增断言覆盖「货架绝不调 HarvestRanch」「TriggerProduce 绝不自动调」
    「优先动物买不起时退让」「白名单不命中不发偷取请求」。
- 2026-11-16 **牧场第四轮：纠正 TriggerProduce 误判 + 今日统计对齐**。
  - **纠正上一轮的错误结论**：`TriggerProduce` **不会**收走动物。干净实验（只调它、
    别的都不做）：调用前 3/3 货架 0 → 调用后 **栏位仍 3/3**，货架多出 3 槽各 5 项产物。
    上一轮把「触发生产 → 收货架(harvestRanch)」两步看成一步，才误判成 TriggerProduce 有害。
    `pasture_produce` 开关恢复（前后端），自动流程恢复调用。
  - **完整养殖循环真机跑通**（日志实录）：
    `买入并补栏` → `feed → clean` → `触发生产 1 只动物` → `货架待收` → `收获 1 只`。
  - **`CollectProduce` 判定为服务端不可用**（不是字段问题）：穷举
    `AnimalService`/`RanchService` × 空 body × 字段 1/2/3 × varint/packed/嵌套 message ×
    带 slot_index × 静默 70 秒后单发，**全部 `1020002 网络繁忙`**；同期 `TriggerProduce`
    正常返回业务码 `1045232` → 排除限流与参数错误。函数保留但加警告注释，当前不调用。
    货架产物留给用户进游戏手动收；打通最后一段需要抓一次「收取副产品」的包。
  - **今日统计对齐**（需求 4 的补漏）：农场有 18 项计数器，牧场一项都没接。
    新增 `pastureHarvest/pastureFeed/pastureClean/pastureStroke/pastureRefill/pastureGrass/pastureSteal`，
    在 orchestrator 与 visit 各处 `recordOperation`。真机验证后概览页「今日统计」显示
    `{Harvest:11, Feed:14, Clean:2, Refill:8}`，图标配色与农场项一致。
  - 临时实验端点（`/api/pasture/probe`）用完即删，不留调试入口在生产代码里。
  - 测试：牧场全套 **98 项全绿**（含「触发生产会发请求 / 开关关掉不发 / 已在产不重复触发」
    三条按新结论重写的断言）。
- 2026-11-16 **牧场购买策略（经验/时、收入/时）**。
  - **为什么不能静态算**：动物商店只有 `goods_id/animal_id/price`，成长周期、
    经验、收益全在加密的 `MCAnimalConfig`（FSpk，已确认不可静态解）；
    `AnimalInst.expected_*` 只有「这一轮能拿多少」，不含周期。
  - **改成运行时反推**：新增 `core/src/services/pasture-animal-stats.js` ——
    `placeAnimal` 回包记放栏时刻、每轮拉详情采集 `expected_*`、
    收获时用「收获时刻 − 放栏时刻」得到一个完整周期样本；周期取中位数（留 9 个），
    <1 分钟或 >30 天的样本丢弃防时钟跳变；落盘 `data/pasture-animal-stats.json`。
  - **四种策略**：`cheapest`（默认，价格升序）/ `max_exp`（每小时经验）/
    `max_profit`（每小时收入减买入价，即净收益）/ `preferred`（优先指定动物）。
    **没档案就退回按价格挑，绝不编造经验值** —— 这是硬约定，测试里锁死了。
  - **行为变更**：`pasturePreferredAnimal` 只在 `preferred` 策略下生效
    （之前是「有值就优先」，会和「最便宜」打架），面板已标注。
  - 新增 `GET /api/pasture/animal-stats` 与面板里的档案表
    （动物 / 经验/时 / 收入/时 / 样本数），哪些真算出来、哪些还是 `—` 一眼可见。
  - 测试：`pasture-animal-stats.test.js` 9 项 + orchestrator 追加 4 项，
    牧场全套 **111 项全绿**。
- 2026-11-16 **牧场购买策略合并 UI**：上一版把「优先补栏动物」做成购买策略之外的
  另一块下拉，还挂「（仅「优先指定动物」策略生效）」的括号说明 —— 把一个概念拆成两处。
  现在「优先指定动物」就是购买策略的一个选项，选中后动物下拉同块内联展开；
  没选动物时直接提示「还没选动物 —— 没选之前会按最便宜买」。
  数据层仍是 `pastureBuyStrategy` + `pasturePreferredAnimal` 两个字段（算法与动物 ID 职责不同），
  但界面上只有一个入口。
- 2026-11-16 **治理器预算与概览页分区**。
  - **「治理器拦截 GetRanchDetail」根因**：不是牧场占预算，是牧场被挤。真机 60s
    窗口：`GetAll×34 + Enter×27 + Leave×27 + AllLands×11 + Bag×6 + TaskInfo×5` ≈ 135，
    好友 34 个一轮巡查就 102 次。旧 80/30 必然满载，牧场 20-30 秒一轮撞上就被拦。
  - **预算 80/30 → 140/36**；牧场 tick 整轮预检（余量 5）、任务扫描预检（余量 2）、
    好友巡查派发留余量（帮忙 15 / 偷菜 8，偷菜低因为它是核心收益）。
    真机：牧场+任务被拦从 10 次/6min 降到 3 次/6min，整轮停摆消失。
  - **试过放弃的两条路**：① 给 `getAllFriends` 加缓存 —— `friend-summary-backoff.test.js`
    有一批测试精确断言「每轮读一次」与「并发=独立请求」，那是治理拒绝归因精度
    的前提；加缓存挂 4 项，其中一项说明缓存会把失败读取伪装成成功、错误续期
    成熟窗口证据。② 继续追预算 —— 好友数会涨，只是追数字。
  - **概览页分区**：顶部 全部/农场/牧场 三段切换，统计按 `pasture` 前缀分成
    农场 15 项 / 牧场 7 项两张卡；牧场分区补了动物栏位表（栏位/阶段/可收获或倒计时）。
  - **布局坑**：`md:flex-row` 里塞 4 个兄弟会被 `flex-shrink` 压扁（倒计时竖排换行），
    改 `md:flex-wrap` + 左栏 `flex-1` + 右栏定宽 `w-80` + 后两卡 `w-full`。
  - **模板大手术的教训**：整块切分重组两次都弄坏了嵌套（未闭合标签 → vue-tsc 报
    「所有导入未使用」）。改成三步小改（Tab → v-if → 声明式卡片）+ 每步用
    `@vue/compiler-sfc` 的 `parse()` 验证 `errors.length === 0`，才一次过。
- 2026-11-17 **牧场整晚不运行的真因：偷菜 tick 把它饿死**。
  - **根因**：统一调度器 `} else if (shouldSteal || stealIsDue()) { await runStealTick(); return; }`
    —— 偷菜快路径 1.5-3 秒到期一次，`shouldSteal` 几乎恒真，每轮 tick 都在这
    `return` 掉，排在后面的 `runFarmTick`/`runHelpTick`/`runPastureTick` 一次都轮不到。
    **与牧场开关无关**（`pasture_refill`/`pasture_buy_animal` 当时确实是上一轮为
    阻止花钱关掉的，但全开也照样不跑）。
  - **修法**：删掉 `return`；三个 tick 各有 `xxxTaskRunning` 守卫不会重入。
    回归测试 `pasture-tick-starvation.test.js` 直接查源码断言「偷菜调用后到下一个
    else-if 之间不得有裸 return」，加回 return 立即失败（已验证）。
  - **修后真机**：`00:11:32 买入并补栏 1 只 → 00:11:39 投喂 → 00:12:19 收获 1 只
    + 领取牧场每日任务`，完整循环跑通。
  - **顺带预算 140/36 → 160/48**：`GetAll` 实测 36-38 次/60s（读取门「成功即重置」，
    偷菜快路径每 1.5-3 秒重读一次），这频率是测试保护的契约，加节流挂 6 项已回滚，
    只能让预算容下真实需求。
  - 顺手把 `pasture_refill` / `pasture_buy_animal` 打开（之前为阻止买入关掉，
    导致牧场一直是空栏位 0/3，没有可操作对象）。
- 2026-11-17 **治理器预算首次有实测依据**。
  - **问题**：此前预算是 40/15 → 80/30 → … → 160/48，**全是「撞到拦截就调高」拍的**，
    从没问过官方客户端自己一分钟发多少。注释里「远低于异常风暴量级」毫无依据。
  - **拿到基准**：新增 `core/scripts/analyze-har-rate.js`，从官方客户端 HAR 里解析
    游戏 WebSocket 帧（`flow=0` 是客户端发出，带毫秒时间戳；**payload 虽加密但
    protobuf 头部的服务名/方法名是明文**），既能数总量也能数单接口。
  - **官方实测**（Windows 微信 1.17.0.3_20261117，正常游玩 160 秒）：启动 30s
    246 次/分钟、稳态 **113 次/分钟**、60s 峰值 **278 次**、最高单接口
    `PutWeeds` **55/60s**、`GetRanchDetail` 峰值 9/60s。
  - **据此定 200/55**：官方稳态 1.8 倍、官方峰值 72%，单接口对齐官方最高实测值。
    **结论反转：官方自己就能一分钟发 278 个请求而账号无恙，压到 160 以下反而会
    拦掉我们自己的正常业务。**
  - **结构性差异（记录但不违规）**：好友访问 30/min vs 官方 16；`GetAll` 36-38 vs
    官方三个列表接口合计 ~30；牧场 2-3/min 反而比官方稀疏。
  - HAR 含登录 code 与 gid，不入库；只提交脚本、`docs/request-governor-baseline.md`
    和代码注释。测试 `har-rate-baseline.test.js` 4 项验证解析器本身。
- 2026-11-17 **按官方基准落地 + 牧场加速**。
  - **牧场轮询 20-30 秒 → 7-10 秒**：官方 `GetRanchDetail` 实测峰值 9/60s（约 6.7 秒
    一次），旧间隔比正常游玩还稀疏三倍，产物和灾害都压着不动。默认值、`store.js`、
    `config.js`、worker 三处回退值、前端默认方案全部同步；**已保存的账号配置
    会覆盖默认值**，所以额外通过 `/api/settings/save` 更新了当前账号的 intervals。
  - **`GetAll` 从 36-38 次/60s 降到 2-3 次/60s** —— 关键是上一轮删掉偷菜分支的
    `return`：恢复后 `runStealTick` 跑完正常把下次唤醒推到
    `stealRediscoveryDelayMs()`（5-8 分钟），而不是被反复叫醒重读列表。
    **饿死其它 tick 的那行 `return` 同时也是请求风暴的源头。**
    （加读取节流会挂 8 项测试，已回滚两次，确认不可行。）
  - **真机效果（6 分钟）**：治理器拦截 **22 次 → 1 次**，窗口不再常驻满载；
    牧场按 9 秒节奏跑，`投喂 → 收获` 循环正常。
  - **货架日志降噪**：`CollectProduce` 服务端不可用，货架产物只能手动收；
    7-10 秒一轮会把它刷满日志，改为「数量变化才记一条」。
- 2026-11-17 **捡蛋就是 HarvestRanch；CollectProduce 不存在**。
  - **证据**：官方 HAR 两次全量扫描（160 秒正常游玩 70 种接口；明确「催产+捡蛋」
    各两次）都没有 CollectProduce。第二份的服务端回包显示 HarvestRanch 之后
    `animal_count` 始终 4、`produce_count` 变化 —— **动物一只没少，产物被收走**。
  - **结论**：`HarvestRanch` 按动物状态决定行为：生产中(3) 只交产物留栏，
    可收获(5) 才收出栏。早先「收货架把三只鸡收出栏」是因为那三只当时正处于
    可收获状态，**不是接口用错**。`CollectProduce` 是网关不存在的方法，这才是它
    无论发什么字段都返回 `1020002` 的原因。
  - **改动**：删 `performCollectShelves`，货架收取并入 `performHarvest` ——
    「有成熟动物」或「货架有产物」任一成立就发**一次** HarvestRanch，两者同收。
    日志区分「捡蛋 N 项（动物留栏）」与「收获 N 只」，统计新增 `pastureCollect`。
  - **真机验证**：连续四轮 `捡蛋 1 项（动物留栏）→ 收获 1 只 → 捡蛋 → 收获`，
    货架待收从「一直堆着」变成 **0**。
  - **方法教训**：我曾用 `grep CollectProduce HAR` 得 0 次就下结论 —— **无效方法**，
    HAR payload 是 base64，grep 原文永远找不到方法名。必须解码帧再匹配。
- 2026-11-17 **牧场「跑一轮就停」的真正原因（三个）**。
  - **① 买动物成功也套 10 分钟冷却 + 每轮只买 1 只**（最直接）：注释写「失败或
    余额不足后 10 分钟不再尝试」，但成功买入也设了 `lastBuyAnimalAtMs`。3 个空栏位
    要 30 分钟填满 → 表现为「养一只收一只之后再也不动」。修法：长冷却只留给失败，
    一轮把空位填满（余额递减后重挑）。
  - **② 掉线时 `pastureTaskRunning` 永久卡死**：`finally` 只在 try 结束时执行，
    WebSocket 掉线时 `sendMsgAsync` 的 promise 既不 resolve 也不 reject → await
    永挂 → 之后每轮 tick 在第一行 return，**不报错不写日志**。真机链条：
    01:35:46 被踢 → 01:36:39 重登 → 跑一轮 → 静默 15 分钟（同期农场/好友正常）。
    修法：`checkPasture` 包 45 秒硬超时 + 下一轮发现卡住 >60 秒强制复位
    （`pasture_tick_stall`）。
  - **③ 被踢重登退避 5min/30min/1h/3h**：防顶号拉锯的设计，但用户「偶尔进游戏
    看一眼」后要等很久。首次 5 分钟保留（否则用户在游戏里时会被反复踢）。
  - **最终真机**：`投喂 3 只 → 触发生产 3 只 → 收获 3 只（+3 经验）+ 捡蛋 3 项 →
    本轮共补栏 3 只（余额 36056）→ 继续投喂`，栏位稳定 3/3、全部 stage=3。
  - **必须让用户知道**：他在游戏里操作时 bot 必然被踢下线，这是微信单端登录的
    物理限制，不是 bug。
- 2026-11-17 **牧场确实在跑，但产物不变成牧场币（净亏 6/轮）**。
  - **先确认在运行**：统计 `收获115 / 投喂194 / 补栏115 / 捡蛋106`，日志
    `trigger_produce → 捡蛋 → 收获 → 补栏3只 → feed` 循环持续。用户看到 0/3 是
    「收获完、4 秒后补栏」之间的空档。
  - **真问题**：余额每轮固定 -6（3 只 × 2 币），产物一分没变成 1007。背包实测
    `1007` 持续下降、`1102` 缓慢上升，而收获产出的 `item 1060003` **背包里根本没有**。
  - **harvest_type 语义（错误码确定）**：改默认值为 2 后服务端报
    **`1045229 当前没有可收取的产物`** → `1`=收获（动物出栏，产物只给经验）、
    `2`=只收产物。现按情况分用：有成熟动物用 1，只有货架产物用 2；
    1045229 按正常状态处理（analysis 与服务端快照短暂不同步会撞到），不刷警告。
  - **未打通**：官方响应 field5 是 `item 1060003 x30` + `item 1102 x420`，但
    `ItemService.Bag` 里查不到 1060003，1102 增速也远低于 420/次 —— 产物被服务端
    消费，既没进背包也没换牧场币。**需要一次「卖牧场产物」或「点牧场仓库」的抓包。**
  - 在此之前自动买动物是净亏（-6/轮），是否继续需人工决定。
- 2026-11-17 **「一直在买动物」的真正原因（补栏条件一直是对的）**。
  - 用户原话：「应该是栏里没有动物的时候自动购买补充，而不是一直买」。
    `performRefillSlots` 开头就是 `if (!analysis.emptySlots.length) return 0` ——
    **只有栏位真空了才买，这个逻辑从来没写错**。问题是栏位为什么一直空。
  - **① 我们每轮都催产，而 `TriggerProduce` 是催熟**：催一次动物很快从 stage 3
    走到 stage 5（可收获）→ 被收出栏 → 栏位空 → 重买，**40-90 秒一轮**。
    官方抓包 160 秒只催 2 次、4 只动物全程 stage 3。→ 加 `PRODUCE_COOLDOWN_MS=5min`。
  - **② 可收获动物被立即出栏**：便宜动物（鸡 2 币）只产一次就走完生命周期。
    → 加 `HARVEST_DEFER_MS=10min`，等够才收出栏；可用
    `FARM_PASTURE_HARVEST_DEFER_MS` 调整，测试里设 0 保持旧行为。
  - **③ `harvest_type` 用错会顺手收走动物**：有货架产物时必须用 2（只收产物），
    用 1 会让产物走收获路径、动物一起出栏。第十轮已按 `1045229` 定死。
  - **真机对比**：5 分钟内补栏 **4 次 → 0 次**；栏位从 `0/3 ↔ 3/3` 反复变成稳定
    `3/3`；动作从「买→催→捡→收→买」变成只捡蛋。
- 2026-11-17 **修正：可收就收，节奏由催产冷却控制**。
  - 上一轮加的「可收获动物等 10 分钟才出栏」是**错的手段**：页面写着「可收获 3」
    却按着不收，用户看到的像是卡死。
  - 正确分工：**收获**看到 `can_harvest` 就收；**节奏**由 `PRODUCE_COOLDOWN_MS=5min`
    的催产冷却控制 —— `TriggerProduce` 是催熟，它才是把动物推到 stage 5 的那一步，
    压住催产生命周期自然就慢，压住收获只会让人以为坏了。
  - **真机一个完整周期**：`03:44:44 补栏 → 03:49:23 催产(冷却到期) → 03:49:32 捡蛋
    → 03:49:41 收获 3 只出栏 → 03:49:50 补栏 3 只`，**一轮 5 分 6 秒**，
    改前 41 秒，降幅 87%。
