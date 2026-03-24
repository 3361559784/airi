# OS-first 多 Surface Agent 路线

> 文件名已经不再限定“浏览器内 Agent”。
> 这份文档现在的目标不是描述 browser feature list，而是固定一条更接近 **OS 级 Atlas-like agent mode** 的实施路线。

## 结论

如果目标真是接近 Atlas 级 agent mode，最后一定要把：

- `desktop lane`
- `browser lane`
- `terminal lane`
- `AIRI-native lane`

放进一个统一的 agent runtime 里。

但如果你的真实目标不是“做浏览器里的 Atlas”，而是“做操作系统里的 Atlas-like agent mode”，那就必须把优先级说死：

1. `macOS desktop lane` 是主底座，不是过渡品
2. `browser lane` 是高语义 adapter，不是架构中心
3. 真正的耦合点在 `runtime / contract / trace / verify / handoff`
4. 不要把 browser semantics 直接塞回 macOS primitives

一句话：

- **先把 macOS 做硬，是对的**
- 但“做硬”的重点不是更多 click/type，而是 **更有语义、更能自证、更能恢复**

## 先把一个误判打死

很多人会把 “Atlas 级” 误解成：

- 浏览器控制
- 会点按钮
- 会填表单
- 会自己决定下一步

这不够。

更准确的说法应该是：

- Atlas 级不是 “desktop + browser”
- Atlas 级是 “语义观察 + 结果验证 + reroute / recovery + durable audit + bounded replanning”

浏览器只是更容易先拿到这些能力，因为：

- DOM / AX 语义天然更强
- 页面状态更容易验证
- 环境更收敛
- recover / reroute 更容易结构化

而 OS 级 agent 更难，因为这些东西你得自己补出来。

所以你不能因为 Atlas 现在主要体现在浏览器里，就把 browser lane 当成你的中心架构。

## Browser Atlas 和 OS Atlas 的差异

### 浏览器里的 Atlas 更容易靠近

原因不是它“更高级”，而是它天然有：

- DOM tree
- element role / attributes
- 可读状态
- 可验证的 navigation / form / selection 结果
- 更稳定的 target reacquire

### OS 里的 Atlas 更难

因为你要自己建立这些近似物：

- foreground app / window model
- AX tree / role / actionability
- focus ownership
- window reacquire
- selection / clipboard / text anchor
- screen / permission / lease / interrupt / approval
- 动作后到底有没有达成目标的 verify

如果这些语义层没有立住，OS agent 再会点也只是高级 clicker。

## 当前判断

现在仓库里已经有一些 browser 线基础，不是从零开始：

- `src/browser-dom/extension-bridge.ts`
- `src/browser-dom/cdp-bridge.ts`
- `src/strategy.ts` 里已经有 `use_browser_surface` advisory
- `src/workflows/app-browse-and-act.ts` 已经有一个很初级的 app/browser 工作流模板
- `packages/stage-ui/src/stores/llm.ts` 已经明确区分 desktop 与 browser 的优先 surface
- `packages/stage-ui/src/tools/mcp-reroute.ts` 已经有 outward reroute contract

同时，macOS 线也已经不是 demo：

- `v1`: minimal control skeleton
- `v2`: control quality
- `v3`: minimal safe loop

但无论 desktop 还是 browser，现在都还没形成真正的 Atlas 级 runtime。

最硬的缺口还是这几层：

- 多 surface routing
- 跨 surface 的 run / step / trace 结构
- 结果导向 verify
- durable audit / durable trace
- bounded replanning / recovery
- 更语义化的 desktop substrate

## 从 `/Users/liuziheng/computer_use` 可以直接吸收什么

你那边现成的 `computer_use` 资料，对这份路线文档最有价值的不是“怎么启动 Chrome”，而是两类实现判断：

### 1. browser lane 可以允许 adapter-first 实现

`COMPUTER_USE.md` 里那条链路很干净：

- MCP tool
- spawn CLI
- stdin / stdout JSON
- browser bridge / CDP
- browser instance

这说明 browser lane v1 完全可以允许这种形态：

- **调用即生命周期**
- 不强依赖额外 HTTP 服务
- adapter 可以是 Python CLI、Node CLI、extension bridge 或 CDP bridge
- browser lane contract 不应该绑死在某一种实现语言上

这对现在的路线是加分，不是改方向。

因为它进一步说明：

- `browser lane` 应该先做成 **semantic adapter layer**
- 而不是先做成一大坨常驻 agent 服务

### 2. browser bridge / tool 设计原则是可以直接复用的

`chrome-devtools-mcp` 的设计原则里，有几条非常值得直接吸收进 AIRI 这边：

- `Agent-Agnostic API`
- `Token-Optimized`
- `Small, Deterministic Blocks`
- `Self-Healing Errors`
- `Human-Agent Collaboration`

这几条翻译成你现在这条线的话，就是：

- browser lane / desktop lane 都应尽量保持 **agent-agnostic**，不要把 contract 写死给某个模型
- 返回给上层 runtime 的内容应该优先是 **语义摘要**，不是把原始大对象全糊上去
- 工具应该是 **小而可组合的确定性块**，而不是“神奇大按钮”
- 错误要能驱动 reroute / recovery，而不是只报错
- 输出要同时服务机器和人：既有结构化字段，也有可读 summary

这几条其实不只是 browser 线适用，desktop / terminal / AIRI-native 也适用。

## 现在最重要的架构判断

如果最终目标是 OS-first agent mode，那么：

- `desktop lane` 是 primary substrate
- `browser lane` 是 semantic adapter
- `terminal lane` 是 execution / inspection adapter
- `AIRI-native lane` 是内部能力和工具消费面

因此后面的系统边界应该是：

- `desktop primitives`
- `browser primitives`
- `shared runtime`
- `shared contracts`
- `shared verification vocabulary`

而不是：

- “桌面控制主线”
- “顺手把 browser 塞进去”

这两种做法最后的可维护性差很多。

## 现在不该做的事

这几件事现在都不该做：

- 把 `browser framework` 直接塞进 macOS desktop line
- 在 browser lane 里再发明一套独立 agent loop
- 把浏览器任务默认走 screenshot + click 的视觉路径
- 提前做 captcha / anti-detection / stealth / 反 bot 叙事
- 提前把 OAuth、网页登录、复杂 iframe 包装成“已经 product-ready”
- 因为想追求 Atlas 感，就把 PR 做成跨 desktop/browser/runtime 三层的大坨
- 把 “有两个 surface” 误讲成 “已经接近 Atlas”

一句话：

现在需要的是 **lane separation + runtime groundwork + desktop semantics**，不是大一统表演。

## 现在就该打的铺垫

现在的铺垫应该只做“以后一定会复用”的东西，而且尽量 surface-neutral。

### 1. 固定 surface contract

最少应该固定这些概念：

- `surface`: `desktop` / `browser_dom` / `browser_cdp` / `terminal` / `airi_native`
- `surface decision`
- `reroute instruction`
- `handoff`
- `verification result`
- `recovery reason`

优先落点：

- `src/types.ts`
- `src/workflows/types.ts`
- `src/strategy.ts`

要求：

- browser 不是 desktop 的子类型
- desktop 不是 browser fallback 的别名
- reroute 不是一句自由文本，而是结构化 contract

### 2. 固定 run / step / trace 的共享骨架

同一个任务以后一定会跨 lane，所以这些要尽早变成共享概念：

- `runId`
- `stepId`
- 当前 step 属于哪个 surface
- surface decision history
- handoff reason
- verification summary
- approval / lease / budget 消耗

优先落点：

- `src/state.ts`
- `src/session.ts`
- `src/transparency.ts`
- `src/trace.ts`

注意：

- 现在的 trace 还是进程内存，不够
- 但 trace shape 现在就应该按多 surface 共用来设计

### 3. 固定 verify vocabulary

如果没有统一 verify 语义，后面根本没法做真正的 agent runtime。

现在就该统一这些结果结构：

- `action_applied`
- `state_changed`
- `target_missing`
- `verification_failed`
- `reroute_required`
- `approval_required`
- `interrupted`

优先落点：

- `src/types.ts`
- `src/strategy.ts`
- `src/server/action-executor.ts`
- `src/workflows/engine.ts`

### 4. 固定 reroute / handoff outward contract

关键文件：

- `src/server/workflow-formatter.ts`
- `packages/stage-ui/src/tools/mcp-reroute.ts`
- `packages/stage-ui/src/tools/mcp-prompt-content.ts`
- `packages/stage-ui/src/tools/mcp.ts`

要求：

- reroute 对 AIRI 来说必须是结构化信号
- browser availability / preferred surface / explanation 都要是稳定字段
- handoff 要能表达 “为什么从 browser 切 desktop” 和 “为什么从 desktop 切 browser”
- 错误要尽量自带修复方向，而不是让上层 runtime 自己猜

### 5. 固定 support matrix 的 lane 视角

关键文件：

- `src/support-matrix.ts`

要求：

- browser lane 单独算
- desktop lane 单独算
- multi-surface runtime 以后也单独算
- 不要把“有代码”误写成“product-supported”

### 6. 固定 token-aware observation / summary 习惯

这一点在 browser lane 尤其重要，但其实所有 surface 都该遵守。

要求：

- 默认返回结构化摘要，不默认返回大块原始 payload
- 大体量内容优先存 artifact / file，再返回摘要与引用
- snapshot / page / AX / trace 的输出都应优先 token-aware

原因不是省 token 这么简单，而是：

- 多 surface runtime 迟早会碰长会话
- 如果 observation 默认过胖，runtime 会迅速退化

优先落点：

- `src/transparency.ts`
- `src/server/workflow-formatter.ts`
- `packages/stage-ui/src/tools/mcp-reroute.ts`
- `packages/stage-ui/src/tools/mcp-prompt-content.ts`

## 现在最该补的一层：Desktop Semantic Layer

如果你的目标是 OS-first agent mode，这一层比 browser lane 更关键。

你现在最该建立的是：

### 1. foreground context model

最少要稳定拿到：

- 当前前台 app
- 当前前台 window
- window title / bundle id / pid
- display / space / focus holder

### 2. window targeting / reacquire

要能表达：

- 我要操作哪个窗口
- 窗口丢了怎么找回来
- 窗口被遮挡 / 切走 / 重建后怎么 reacquire

### 3. AX-backed semantic observation

重点不是“有没有 AX”，而是能不能抽象出：

- role
- label / title / value
- enabled / focused / selected
- actionability
- parent / child / frame

### 4. text / selection / clipboard semantics

OS 级任务里，这层非常重要：

- 当前焦点文本控件是谁
- 当前 selection 是什么
- 输入是打字、粘贴还是 AX set value
- 失败时能不能结构化恢复

### 5. desktop-side verify

要尽快摆脱这种判断：

- 我点了
- 我打字了

应该转向：

- 焦点变了没有
- 值变了没有
- 窗口状态变了没有
- 目标 app / window / element 真的达到预期没有

这一层如果没有立住，后面 browser lane 再漂亮，也带不动 OS 级 agent。

## 推荐开发顺序

### 阶段 A: 继续收桌面线

你现在已经做到：

- `v1`: minimal macOS control skeleton
- `v2`: control quality
- `v3`: minimal safe loop

下一步最值当的是 `v3.1`，不是急着并 browser。

优先补：

- durable trace / audit
- step outcome verification
- failure classification
- 更像任务的真实 smoke

目的不是“更像 Atlas”，而是先把 desktop lane 的运行骨架做硬。

### 阶段 A2: 做 desktop semantic model

这一步比 browser-v1 更能决定你能不能走向 OS Atlas。

优先补：

- foreground app / window model
- AX-backed semantic observation
- actionability / target reacquire
- selection / clipboard / text semantics
- desktop-side verification

如果这一步跳过，后面 runtime 只会建立在脆弱 clicker 上。

### 阶段 B: 做 browser lane v1

这一步的目标不是做 “browser agent mode”。

只做：

- deterministic browser task lane
- adapter-first implementation is acceptable
- extension bridge 优先
- CDP fallback
- DOM / AX 读写
- 元素定位、值读取、值设置、点击、勾选、选择、等待
- 页面状态验证
- bridge unavailable 时的明确 reroute

实现形态上允许：

- spawn-on-demand CLI adapter
- extension WebSocket bridge
- direct CDP bridge

但要求始终不变：

- 这些都是 **implementation adapter**
- 不应该反过来定义 browser lane contract

不做：

- browser 内部再造一套 planner
- desktop fallback 混进 browser lane 内部
- “只要 DOM 不顺就直接截图点击”的偷懒逻辑
- 高风险网页登录自动化叙事

### 阶段 C: 做 multi-surface runtime

这一步才是接近 Atlas 的开始。

它要解决的是：

- 同一个目标该走哪个 surface
- surface 不通时怎么切 lane
- desktop 与 browser 之间怎么 handoff
- 同一个 `runId` 下怎么统一 trace / budget / approval / recovery
- 什么时候继续，什么时候暂停，什么时候重规划

这一步不该再被描述成 “macOS desktop follow-up”。

它是一个新的系统层。

## Browser Lane v1 应该包含什么

这条线最稳的 scope 应该是：

- `browser_dom_get_bridge_status`
- `browser_dom_get_active_tab`
- `browser_dom_read_page`
- `browser_dom_find_elements`
- `browser_dom_click`
- `browser_dom_read_input_value`
- `browser_dom_set_input_value`
- `browser_dom_check_checkbox`
- `browser_dom_select_option`
- `browser_dom_wait_for_element`
- `browser_dom_get_element_attributes`
- `browser_dom_get_computed_styles`
- `browser_dom_trigger_event`
- `browser_cdp_*` fallback 的稳定路径
- handle stale / frame drift / bridge unavailable 的结构化错误

目标应该是：

- 能稳定读 DOM
- 能稳定改表单
- 能稳定验证页面状态变化
- 能在 bridge 不可用时明确 reroute

不是：

- 一上来做“浏览器版 agent loop”
- 一上来做通用网页自治

## 现在就可以提前预留的文件落点

### 共享契约层

- `src/types.ts`
- `src/workflows/types.ts`
- `src/strategy.ts`
- `src/state.ts`
- `src/session.ts`
- `src/transparency.ts`
- `src/support-matrix.ts`

### desktop semantic layer

- `src/accessibility/*`
- `src/server/action-executor.ts`
- `src/state.ts`
- `src/session.ts`
- `src/trace.ts`
- `src/transparency.ts`

### 浏览器 lane 本体

- `src/browser-dom/extension-bridge.ts`
- `src/browser-dom/cdp-bridge.ts`
- `src/server/register-tools.ts`
- `src/server/action-executor.ts`
- `src/workflows/app-browse-and-act.ts`

### AIRI 消费面

- `packages/stage-ui/src/stores/llm.ts`
- `packages/stage-ui/src/stores/llm-tool-loop.ts`
- `packages/stage-ui/src/tools/mcp-reroute.ts`
- `packages/stage-ui/src/tools/mcp-prompt-content.ts`
- `packages/stage-ui/src/tools/mcp.ts`

重点提醒：

- 如果未来真的要恢复 app 侧专门的 browser runtime，也要把它当 adapter
- 不要让 app 侧 runtime 反过来定义 browser lane contract
- 不要让 browser lane 反过来定义 OS agent 的核心抽象

## 验证原则

最容易犯的蠢病就是“为了 test 去写 test”。

这一条要提前写死：

- 测真实任务族，不测摆拍脚本
- 测 contract，不测实现细节顺序
- 测 verify，不测“好像调用过这个方法”
- 测 reroute / fallback / recovery，不只测 happy path

更具体地说，应该优先测：

- desktop lane 的 verify / recovery 是否成立
- browser bridge 可用时，DOM 读写与验证是否成立
- extension 不可用时，CDP fallback 是否成立
- 两者都不可用时，reroute 是否明确
- stale handle / frame drift / tab change 时，是否 fail closed
- browser 与 desktop/AIRI 之间值传递时，是否优先结构化读取或剪贴板，而不是盲打

而不是测：

- 第一步点这里
- 第二步输入这里
- 第三步再点这里

那种脚本顺序测试很容易把系统训练成表演型实现。

## 什么时候才配谈 “Atlas 级”

满足下面这些之前，不要把这条线描述成 Atlas 级 agent mode：

- desktop lane 自己已经是稳定 lane，不是 clicker 工具拼盘
- browser lane 是稳定 lane，不是工具拼盘
- desktop / browser / terminal 之间有统一 runtime
- trace / audit / budget / approval 是跨 surface 共用的
- verify 真的是结果导向，不是动作导向
- run 失败后可以 recovery / reroute / bounded replan

在那之前，更诚实的说法应该是：

- desktop lane 已经成形
- desktop semantic layer 还在建设
- browser lane 还在建设
- multi-surface runtime 还未真正落地

## 一句话版本

如果你的目标是 OS-first 的 Atlas-like agent mode，那么先完善 macOS 是对的。  
但要优先补的是 **desktop semantics、verify、trace、recovery**，不是急着把 browser 塞进 desktop 线。  
browser lane 很重要，但它应该是 **adapter**，不是你的中心架构。
