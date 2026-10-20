# Repository Agent Notes

## QQ 农场官方源码位置（macOS）

Mac QQ 会把 QQ 小游戏源码自动展开到：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src/
```

QQ 农场 AppID：

```text
1112386029
```

农场源码版本目录匹配：

```text
1112386029_3_*
```

每次 QQ 农场更新后目录尾部哈希都会变化。不要把某一个哈希目录永久视为最新版；
应按其中 `tsdk/tsdk.wasm` 的修改时间选择最新且完整的目录：

```bash
QQ_MINIAPP_SRC="$HOME/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src"

find "$QQ_MINIAPP_SRC" -path '*/1112386029_3_*/tsdk/tsdk.wasm' \
  -exec stat -f '%m %Sm %z %N' -t '%Y-%m-%d %H:%M:%S' {} \; | sort -nr
```

候选目录至少应包含：

```text
game.js
game.json
tsdk/tsdk.wasm
assets/
```

当前曾确认的 2026-07-29 展开目录为：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src/1112386029_3_67b898be9fed43f96df1108d3f31f25b/
```

该路径仅作为已知样例；开始分析前仍需执行上面的时间排序。

## QQ 农场远程资源缓存（macOS）

活动界面、种子/作物贴图、Prefab、Spine 和其他远程 bundle 通常不全部位于
`miniapp_src`，而是在各 QQ 账号的运行资源缓存中：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/fs/*/1112386029/usr/gamecaches/
```

资源 URL 与本地缓存文件的映射记录在：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/fs/*/1112386029/usr/gamecaches/cacheList.json
```

常见 bundle：

```text
mainscene/
extraRes/
plant/
delayRes/
audio/
petdog/
```

分析官方文件时只读源目录，先复制到临时目录再处理，不要直接修改 QQ 容器缓存。
WASM 更新的完整发现、快照、比较、验证和回退流程见：

```text
core/docs/tsdk-update-runbook.md
```

## 微信小游戏（同一游戏的另一入口）

微信端 AppID 为 `wx5306c5978fdb76e4`，与 QQ 端共用同一个游戏后端、同一套 TSDK。

微信不会把包展开成目录，必须解包；Windows PC 微信的 `.wxapkg` 还带 `V1MMWX` 加密。

```text
Windows: %APPDATA%\Tencent\xwechat\radium\users\<hash>\applet\packages\wx5306c5978fdb76e4\<版本>\
macOS:   ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users/<hash>/applet/packages/wx5306c5978fdb76e4/
```

一条命令完成定位、解密和解包：

```bash
npm run unpack:wx
```

远程资源（贴图、Spine、活动图）：

```text
.../applet/local/wx5306c5978fdb76e4/usr/gamecaches/
```

结构与 QQ `gamecaches` 相同，只是 `cacheList.json` 前缀为 `wxfile://`，CDN 同为
`cdn-resource.nqf.qq.com`。`npm run extract:plant-phases` 已自动探测两种平台。

## 活动植物占地大小

向 `core/src/gameConfig/EventPlants.json` 补充活动植物时，不要只填写 ID、名称和
资源映射。必须同时核实作物占地大小；四格（2x2）作物需要显式填写：

```json
{ "id": 1029003, "seed_id": 29003, "fruit_id": 49003, "name": "星语铃花", "size": 2 }
```

省略 `size: 2` 会使活动作物默认按单格作物处理，导致它无法进入 2x2 优先种植与
土地预留流程，甚至被背包单格种植策略选中。新增或更新该字段时还要确认
`core/src/config/gameConfig.js` 将 `size` 透传到植物配置，并用测试断言
`getPlantBySeedId(seedId).size === 2`；必要时同时检查背包接口返回的
`plantSize` 是否为 `2`。
