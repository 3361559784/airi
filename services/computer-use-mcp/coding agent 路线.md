# 类 Codex 强 Coding Agent 路线

> 这份文档的目标不是把当前 coding layer 吹成 Codex 等价物。
> 目标是把路线讲清楚：
> **现在是什么、离强 coding agent 还差什么、下一步该先补哪几层。**

## 结论

如果目标是做出 **类似 Codex 的强 coding agent**，那重点绝对不只是：

- 有搜索
- 有 planner
- 会改文件
- 会跑测试

这些只是入场券。

真正决定上限的是：

1. `stateful coding runtime`
2. `workspace isolation + file budget discipline`
3. `result-oriented proving / validation`
4. `failure diagnosis + amend / replan / abort`
5. `repo understanding + retrieval`
6. `long-session memory / compaction / resume`
7. `benchmark / smoke / failure corpus` 驱动的持续收敛

一句话：

- 强 coding agent 不是“会 patch 的 workflow”
- 强 coding agent 是“能进 repo、能定位、能最小改动、能证明结果、能失败恢复、能解释自己”的 runtime

## 先把一个误判打死

很多系统一说“强 agent”，马上就会往这些方向飘：

- 更长的 prompt
- 更多工具
- 更复杂的 planner
- 更自动的 PR 生成

这通常会把系统带歪。

更准确的说法应该是：

- **不是 planner 越花越强**
- **不是 tool list 越长越强**
- **不是能跑完整个 benchmark 就算强**

更强的标准应该是：

- 进入陌生 repo 还能稳定建模
- 改动范围收敛，不乱扩文件
- 验证是结果导向，不是动作导向
- 失败后会收敛，不会无限瞎改
- 能恢复、能续跑、能解释

## 当前定位

`computer-use-mcp` 里的 coding layer 现在更准确的定位是：

- 一个 **minimal integrated coding kernel**
- 已经不是 demo
- 也还绝对不是 Codex-equivalent coding agent

这个定位要和 [`README.md`](/Users/liuziheng/airi/services/computer-use-mcp/README.md#L28) 保持一致。

## 从 `/Users/liuziheng/computer_use` 可以吸收的设计原则

虽然 `/Users/liuziheng/computer_use` 主要是 browser adapter 资料，但里面和 `chrome-devtools-mcp` 相关的几条设计原则，其实对 coding line 也很有用：

- `Agent-Agnostic API`
- `Token-Optimized`
- `Small, Deterministic Blocks`
- `Self-Healing Errors`
- `Human-Agent Collaboration`

翻译到 coding 线里，就是：

- coding tool contract 不要绑死某个模型风格
- 返回给 runtime 的内容应该优先是结构化摘要，不是大段自由文本
- tool 应该保持小而确定，不要堆“万能大工具”
- 错误要尽量带可恢复方向
- 输出既要机器可消费，也要人能读懂

这几条不是装饰性的原则，而是强 coding agent 能不能长期收敛的基础约束。

## 当前已经有的东西

现在这条线不是空白。仓库里已经有一批真东西：

### coding runtime / primitives

- `src/coding/primitives.ts`
- `src/coding/search.ts`
- `src/coding/planner-graph.ts`
- `src/coding/causal-trace.ts`
- `src/coding/diagnosis-case.ts`
- `src/coding/target-case.ts`
- `src/coding/result-shape.ts`

### tool registration / execution

- `src/server/register-coding.ts`
- `src/server/action-executor.ts`
- `src/policy.ts`
- `src/transparency.ts`
- `src/types.ts`

### workflow layer

- `src/workflows/coding-loop.ts`
- `src/workflows/coding-agentic-loop.ts`
- `src/workflows/types.ts`

### proof / benchmark / smoke

- `src/bin/e2e-coding-workflow.ts`
- `src/bin/e2e-coding-agentic-workflow.ts`
- `src/bin/e2e-coding-agentic-failure-corpus.ts`
- `src/bin/benchmark-coding-agentic-v1.ts`
- `src/bin/benchmark-coding-agentic-v2.ts`
- `src/bin/smoke-coding-*`

换句话说，现在已经有：

- search-driven targeting
- bounded DAG planning
- baseline / worktree capture
- deterministic review
- judge-assisted diagnosis
- benchmark / smoke / failure corpus

所以这条线现在的问题不是“没有 agentic feature”。

问题是：

- 这些 feature 还没有被真正收拢成一个 **Codex-like strong runtime**

## 离强 coding agent 还差什么

最硬的差距我会拆成 6 层。

### 1. 没有真正稳的 stateful coding runtime

现在已经有 workflow 和不少状态概念，但还差一层更稳的 coding runtime：

- `runId`
- `session`
- `step`
- `current frontier`
- `amend / retry / abort`
- `validation evidence`
- `final confidence`

这层如果不够硬，workflow 只是串工具，不是强 agent。

### 2. 没有足够强的 proving / validation orchestration

强 coding agent 不是“改完跑个 test 命令”。

它更像：

- 改动前先抓 baseline
- 改动后选最小必要验证
- 验证失败时判断是 patch 问题、目标判断问题、还是验证选择问题
- 验证结果变成 runtime 的一部分

如果没有这层，“会跑测试”只是表演。

而且这里要坚持一个原则：

- 不给上层返回“大坨测试日志”
- 优先返回验证摘要、失败分类、关键证据引用

否则 token 会被验证噪音吃光，runtime 会越来越笨。

### 3. diagnosis 还不够 runtime-native

现在已经有 diagnosis / causal trace / judge-assisted replanning 雏形。

但离强 agent 还差：

- failure taxonomy 更稳定
- diagnosis 直接驱动 amend / replan / abort
- competing diagnosis 的收敛逻辑
- diagnosis artifact 可持续复用

不然 diagnosis 只是事后解释，不是控制回路的一部分。

### 4. repo understanding 还不够像强 coding agent

强 coding agent 在陌生 repo 里强，不是因为“搜索快”，而是因为它会形成局部 repo model：

- 目标文件
- 邻近影响面
- 相关 symbol / references
- 可能的 owner / hot path
- 哪些文件不能乱动
- 最小修复路径

现在已经有 search / impact analysis，但还没完全形成稳定的 `repo understanding layer`。

### 5. workspace discipline 还不够硬

强 coding agent 最怕的不是不会改，而是乱改。

必须更强地约束：

- worktree lifecycle
- repo copy / temp workspace
- touched file budget
- allowed mutation scope
- patch provenance
- dirty tree compatibility

否则 agent 越强，破坏力越大。

### 6. long-session runtime 还不够完整

从脚本和 smoke 名称能看出来，这条线已经开始碰：

- checkpoint recovery
- frontier runtime
- long session compaction
- hierarchical selection

这方向是对的。

但离 Codex-like 还差：

- 真正稳定的 resume
- 更可信的 compaction
- step frontier 不丢语义
- 长会话后的验证与信心维持

## 不该做的事

这几件事现在都不该做：

- 因为想追求 Codex 感，就先把 planner 继续做得更花
- 先做“大一统全自动 PR 代理”，再补验证和恢复
- 把 benchmark 通过误写成 product-ready
- 为了更多“agent 味”而放松 file budget / scope guard
- 把 diagnosis 退化成自由文本总结
- 把工作区隔离做成“最好有”，而不是 runtime 基础设施
- 提前引入 browser / desktop / coding 三层耦合的大 PR

一句话：

现在最该做的是 **runtime hardening + proof loop + workspace discipline**，不是继续堆 fancy agent 叙事。

## 类 Codex 的强 agent，应该长什么样

更诚实的目标画像应该是：

- 进入陌生 monorepo，先 review workspace 再行动
- 用搜索、symbol、impact analysis 收敛目标，而不是乱读
- 只改最小必要文件，不靠“大范围碰碰运气”
- 改完后知道该跑哪个最小验证，而不是只会 `pnpm test`
- 失败了能诊断是 patch 问题、目标问题还是验证问题
- 能把失败变成 amend / replan / abort，而不是死循环
- 中断后还能恢复，不是重新从头表演
- 最后能给出结构化解释：改了什么、为什么、怎么验证、还有什么风险

如果这些没做到，就别碰瓷 Codex 级。

## 推荐开发顺序

### 阶段 A: 把当前 coding kernel 做硬

这一步不追求更“智能”，追求更稳。

优先补：

- durable coding run state
- session / step / frontier 的固定结构
- touched file budget
- workspace isolation lifecycle
- report status 的稳定 schema

优先文件：

- `src/state.ts`
- `src/session.ts`
- `src/types.ts`
- `src/transparency.ts`
- `src/server/action-executor.ts`
- `src/server/register-coding.ts`

目标：

- 让 coding line 从“工具编排”变成“有状态 runtime”

### 阶段 B: 做 proving / recovery loop

这一步比继续做 planner 更值钱。

优先补：

- baseline capture 更稳定
- scoped validation selection
- validation result normalization
- failure classification
- amend / replan / abort transition
- diagnosis artifact 挂回 run state

优先文件：

- `src/coding/primitives.ts`
- `src/coding/result-shape.ts`
- `src/coding/causal-trace.ts`
- `src/coding/diagnosis-case.ts`
- `src/server/action-executor.ts`

目标：

- 让 coding agent 真正形成“改动 -> 验证 -> 诊断 -> 收敛”的闭环

### 阶段 C: 做 repo understanding layer

这一步决定 agent 进陌生仓库时是不是还像样。

优先补：

- search / symbol / reference 的统一证据结构
- impact graph 与 target selection 的稳定 tie-break
- candidate ranking
- hot-path / ownership / blast-radius 近似模型
- context compressor 和 repo evidence 对齐

优先文件：

- `src/coding/search.ts`
- `src/coding/target-case.ts`
- `src/coding/planner-graph.ts`
- `src/coding/primitives.ts`

目标：

- 让 agent 不是“搜索到了就上”，而是会建立局部 repo model

### 阶段 D: 做 long-session Codex-like runtime

这一步才真正开始接近强 agent。

优先补：

- checkpoint / resume
- frontier runtime
- bounded branch comparison
- long-session compaction
- competing diagnosis 收敛
- judge invalid fallback 的稳定策略

优先文件：

- `src/coding/planner-graph.ts`
- `src/coding/causal-trace.ts`
- `src/coding/diagnosis-case.ts`
- `src/state.ts`
- `src/session.ts`
- `src/transparency.ts`

目标：

- 让系统在中长任务里仍然能保持可恢复、可解释、可收敛

### 阶段 E: 再谈更强的 agent 性

这一步才适合碰：

- 更强的 parallel frontier
- 更复杂的 repo-wide change sessions
- 更激进的 benchmark posture
- 更像 Codex 的长程任务编排

在这之前，别抢跑。

## 现在就该固定的 shared contract

coding 线后面一定会需要这些稳定概念：

- `codingRunId`
- `codingSessionId`
- `stepId`
- `selectedTarget`
- `plannedFiles`
- `touchedFiles`
- `validationBaseline`
- `validationResult`
- `diagnosisResult`
- `confidence`
- `nextAction`: `continue` / `amend` / `replan` / `abort`

优先落点：

- `src/types.ts`
- `src/state.ts`
- `src/session.ts`
- `src/transparency.ts`

要求：

- 不是靠自由文本拼状态
- 不是靠 benchmark 脚本自己脑补状态
- 不是每个 workflow 各自定义一套编码方式
- 错误结果里要尽量带 recovery hint，而不是只有报错字符串

## benchmark / smoke 的正确作用

现在这条线已经有 benchmark 和不少 smoke，这很好。

但要把作用讲清楚：

- benchmark 不是宣传材料
- smoke 不是摆拍脚本
- failure corpus 不是“看起来很学术”

它们真正应该服务的是：

- regression detection
- failure taxonomy 稳定
- diagnosis 收敛
- validation 选择质量
- frontier / checkpoint / compaction 的 runtime 可信度

如果后面这些脚本不能持续反哺 runtime，就会退化成演示资产。

## 验证原则

coding 线最容易犯的病，就是“为了 agent 感做很多事，但没有证明能力”。

这条要写死：

- 测 contract，不测表演顺序
- 测 verify / diagnosis / recovery，不只测 happy path
- 测 touched-file discipline，不只测能不能改对
- 测 resume / compaction，不只测单回合成功
- 测陌生 repo / dirty tree / partial failure，不只测理想样本

更具体地说，应该优先测：

- 目标选错时能否 fail closed
- patch 正确但验证选错时能否识别
- diagnosis 不稳定时是否 fallback 到保守路径
- worktree / repo copy 丢失时能否恢复
- 多文件计划里 checkpoint 是否真的起作用
- 长 session 后 context compaction 是否还能保留关键语义

## 什么时候才配谈 “类 Codex 强 agent”

满足下面这些之前，不要把这条线描述成类似 Codex 的强 coding agent：

- coding runtime 自己是稳定 runtime，不是 workflow 拼盘
- proving / validation 是结果导向，不是“跑了命令”
- diagnosis 真能驱动 amend / replan / abort
- repo understanding 能在陌生仓库里稳定收敛目标
- worktree / scope / touched file budget 是硬约束
- long-session resume / compaction 不再是脆弱实验
- benchmark / smoke / failure corpus 持续为 runtime 收敛服务

在那之前，更诚实的说法应该是：

- 已经有 usable coding kernel
- agentic coding runtime 正在建设
- 离 Codex-like 强 coding agent 还有明显系统差距

## 一句话版本

如果目标是做出类似 Codex 的强 coding agent，那么现在最该补的不是更花的 planner，而是：

- `stateful runtime`
- `proof / validation loop`
- `diagnosis-driven recovery`
- `repo understanding`
- `workspace discipline`
- `long-session resume / compaction`

先把这些做硬，后面更强的 agent 性才不会变成表演。
