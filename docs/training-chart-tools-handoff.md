# Project Handoff: 训练页面画线与十字光标

Generated: 2026-10-04
Workspace: D:/ChatGPT/k线训练
Previous task: unknown
Previous task title: unknown
Revision: main / 50d1502；含未提交改动，尚未形成当前功能的完整提交快照。

## Migration gate

- Intent: CHECKPOINT
- Status: NOT-REQUESTED
- Trigger: USER-REQUEST
- Prompt: 用户要求先整理这一方向的方案，稍后自行新开对话执行。
- Observed: 2026-10-04；没有要求本轮代为新建、跳转或归档对话。

## Objective

交付可独立读取的训练页面实施方案，减少新对话依赖长聊天。主方案为 `docs/training-chart-tools-plan.md`，本文件只作状态和证据索引。本轮完成条件是文档和交接结构核对，不是页面功能已实现。

## Global plan

这里只导出用户指定的训练页面方向，不迁移完整产品路线。

| Milestone | Outcome | State | Dependencies | Evidence |
|---|---|---|---|---|
| 范围和实施文档 | 已确认交互及验收可直接读取 | DONE | 用户讨论、当前代码检查 | `docs/training-chart-tools-plan.md` |
| 光标与读数 | 不吸附、跨图对齐、不改变交易 | DEFERRED | 后续用户明确要求执行、当前状态核对 | 主方案2.2、5、6节 |
| 主副图画线 | 主图价位／区间／趋势；副图趋势 | DEFERRED | 坐标转换与模式隔离 | 主方案2.1、2.3节 |
| 标记保存与复盘查看 | 历史不覆盖、旧备份兼容、各局隔离 | DEFERRED | 图表工具及既有保存链路 | 主方案3节 |
| 回归与截图交付 | 边界断言、真实行情检查、桌面手机原图 | DEFERRED | 上述功能完成 | 主方案6节 |

## Focus confirmation

- Status: USER-CONFIRMED
- Focus: 当前仅整理训练页面方向的方案和交接文件；未授权本轮实现功能。
- Done condition: 实施文档可读取，交接结构通过检查，提供文件链接。
- Future task: 如果新对话的用户明确要求执行主方案，该新请求才确立实施范围；若没有明确选择工作，遵循 $project-handoff 的询问流程。不要把本次文档准备视为自动实施或自动迁移许可。

## Constraints

- 保留当前主图／右栏布局、深蓝风格、成交计算、指标定义、波段划分及样本规则。
- 光标自由移动；真实数据对应最近的已显示K线，不插值或读取未来行情。
- 画线属于各自面板，以行情坐标保存；原记录及创建／修订历史不覆盖。
- 工具和点击必须与笔记、双击分时及触屏拖动区分。
- 不复制全部聊天、不将个人习惯当作有效策略、不在本轮扩展复盘教学或后端。

## Approval boundaries

- Sources: 已检查 `C:/Users/1/.codex/AGENTS.md`，当前为空；工作目录及其父目录、`docs/` 未发现适用的 `AGENTS.md`。新对话仍需重新核对实际项目指令。
- Planned confirmation-required action: none；本轮只有两份新增Markdown文档。独立分支／worktree、发布、系统依赖、正式接口或不兼容格式等扩展须依当时用户指令及权限另行处理。
- Status: NOT-REQUIRED

## Current state

- [CONFIRMED] 2026-10-04核对当前目录、分支和提交；`app.js`、`index.html`、`styles.css`、`server.py` 等有既存修改，`review_rules.js`、`qa/`、`docs/` 等含未追踪成果，不能清理或以旧版本覆盖。
- [CONFIRMED] 主副图共享 `chartCanvas`；已有拖动、缩放、单击笔记与双击分时。已有笔记中的手工价位／区间及历史，尚未看到完整直接画线或联动十字光标实现。
- [CONFIRMED] 当前指标使用250根预热数组与可见行情；KDJ、量均线和MACD已有计算入口。光标必须复用这些口径。
- [REPORTED] 用户已认可当前布局，要求主副图画线和不吸附光标，后续自行新开对话执行本方向。
- [REPORTED] `docs/review-trial.md` 记载18765试用页、隔离数据副本及旧验收证据；本轮未重验服务状态和数据数量。
- [UNKNOWN] 新对话所在目录、服务可用性、浏览器运行状态及后续代码变更，均须在实施前重新核对。

## Decisions

- 一份主实施方案、一个短交接索引，避免复制聊天和产生两套需求。
- 光标刻度和实际K线读数分开，防止自由移动导致虚构中间指标。
- 图表观察不改变当前成交时点；创建时可见范围及顺序比锚点日期更能还原决策依据。
- 当前准备不启动页面实现或自动创建新对话；后续用户的明确请求优先于本文件中的旧状态。

## Evidence map

| Claim or artifact | Status | Evidence | Observed |
|---|---|---|---|
| 目录、分支、未提交状态 | CONFIRMED | 本轮只读Git状态；`main / 50d1502` | 2026-10-04 |
| 图表及点击入口 | CONFIRMED | `app.js`：`drawChart`、`chartHitTest`、拖动函数 | 2026-10-04 |
| 标记与保存 | CONFIRMED | `manualKeyLevels`、`saveDraftSession`、`reviewArchivePayload` | 2026-10-04 |
| 指标面板 | CONFIRMED | `indicatorData`、`drawSubIndicators`、MACD／KDJ绘图 | 2026-10-04 |
| 资源及回归 | CONFIRMED | `sw.js`、`package.json`、`qa/layout-screenshots.cjs` | 2026-10-04 |
| 试用方式、旧真实数据验证 | REPORTED | `docs/review-trial.md`，未重跑 | 2026-10-04 |

## Changes

| File or external object | Change | State / provenance |
|---|---|---|
| `docs/training-chart-tools-plan.md` | 新增本方向实施方案 | 本轮新增，未提交 |
| `docs/training-chart-tools-handoff.md` | 新增交接索引 | 本轮新增，未提交 |
| 现有代码、运行服务、个人数据 | 未更改 | 既存改动归属不推断 |

## Validation

- `python C:/Users/1/.codex/skills/project-handoff/scripts/validate_handoff.py docs/training-chart-tools-handoff.md` — 2026-10-04通过：`PASS: 0 errors, 0 warning(s)`。仅确认交接结构，不代表页面实现、运行状态或功能验收通过。
- 本轮未运行页面或交易回归；主方案6节列的是未来验收要求，不是通过记录。

## Risks and open questions

1. **NON-BLOCKING:** 当前提交不包含所有工作区成果；另建worktree时须核对基准，否则可能丢失复盘版本。
2. **NON-BLOCKING:** 多个模块可能共同改动前端文件；并行前约定边界，集成时比较局部差异。
3. **NON-BLOCKING:** 旧标记可能缺少动作顺序，不能追溯补造原始计划；保存扩展需保持旧档兼容。
4. 暂未发现阻止方案交付的事项；后续服务和测试环境状态未核实。

## Next actions

1. 在新对话先读取主方案和本索引，核对新用户是否已明确要求执行；没有明确工作目标时只询问“接下来最重要的工作是什么？”。
2. 目标明确后只读核对当前目录、项目指令、工作区和测试环境，保留不在任务范围内的用户改动。
3. 按主方案分阶段落实、验证和交付；本文件中的日期、行号及旧验收不能代替当前检查。

## Bootstrap prompt

使用 $project-handoff 理解本索引；它是CHECKPOINT，不表示已经发生任务迁移，也不构成执行授权。用户在新对话若明确要求实施 `docs/training-chart-tools-plan.md`，以该新请求为主要任务，读取主方案并核对当前状态后推进，不重复确认已定的工具范围。如果用户尚未指定工作，先做简短说明并询问“接下来最重要的工作是什么？”。遵循当前项目指令和权限，保留既有改动，区分方案、实施和已验证成果。

## Post-resumption implementation status

Updated 2026-10-04 after the user directly requested implementation from this handoff and subsequently asked for long-press line translation. The earlier `DEFERRED` milestone table and `NOT-REQUESTED` gate above describe preparation before the first implementation request; they are historical context. Current validation includes mouse-drag translation, touch long-press translation, and endpoint adjustment. The authoritative feature and test record is `docs/training-chart-tools-plan.md`, section 7. Refreshed full-page screenshots are `.qa-runtime/chart-tools-20261004/chart-tools-1366.png` and `chart-tools-390.png`. The current UI, backup, and review-archive fields are described in that section.
