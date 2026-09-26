# P10-Step8 完成报告 —— 想法归属纠偏 + 重置按钮

> 一次性修复 MethodAtlas 的两个问题：**组合想法产出归属错位** 与 **缺少重置入口**。

---

## 一、需求 A：新增「重置」按钮

### A1 入口位置
在**右侧工具栏**「视图」列表下方、「重置」分组里放了两个按钮：

| 按钮 | 测试钩子 | 语义 |
|---|---|---|
| 重置为运行前状态 | `data-reset-run` | 只清前端运行态，不动库 |
| 彻底重置运行数据 | `data-reset-data` | 额外删除已生成的想法 / 击穿结果 / 手术 |

放在右栏这一格的**原因**：右栏是"动作区"，重置是动作，语义对；且该格位于可滚动的论文切换器**上方**，不会被论文数量顶出视口——入口永远可见。

### A2 一级重置清什么、留什么

**清空（前端运行态）**
- 目标债务 `contextDebtId`、想法上下文 `contextIdeaId`、来源步骤 `fromStep`
- 已选模块 `pickedBlockIds`、已选债务 `pickedDebtIds`
- 「跑过」标记 `hasRun`（空态文案随之回到 `never-run`）
- 击穿测试选中的想法 `crashIdeaIds`
- 选中项 `selectedId`（详情面板随之收起）
- 剪刀模式 `surgeryMode`

**保留（基础数据，一个字都不动）**
Project / Paper / EvidenceRef / MethodDNA / MethodBlock / Relation / ResearchDebt / DebtSource / Attempt
—— 也就是需求原话的「已导入论文、DNA、演化、债务」。

一级重置**不切视图**：用户在击穿测试页点重置，就应该还站在击穿测试页看它变干净。

### A3 二次确认
新增 `src/components/lab/ConfirmDialog.tsx`。

- **为什么不用 `window.confirm`**：原生弹窗会**阻塞 JS 主线程**，Playwright 一旦忘了注册 dialog handler，断言就以"超时"这种零信息量的方式失败。自渲染的 DOM 对话框可以直接点。
- **为什么是 `<div role="dialog">` 而不是 `<aside>`**：这是本项目的**硬约束**。`verify-panel-toolbar.py:88` 用裸的 `query_selector("aside")` 取右侧工具栏来量它的 `boundingBox.left`；而折叠态右栏本身就是一个 `<aside>`，展开态 `RightToolbar` 的根节点也是 `<aside>`。新浮层若也用 `<aside>` 且先于右栏出现在 DOM 里，几何断言就会量错对象。
- Esc 关闭走**捕获阶段**（`addEventListener(..., true)`）：画布上有自己的 Esc 处理（退出剪刀模式），冒泡阶段可能被 `stopPropagation` 截住。
- 二级重置用红色确认按钮（`data-confirm-danger="1"`）。

### A4 重置后状态与首次进入一致
重置后 URL 里不再带 `blockIds`/`debtIds`/`ran`/`crashIdeaIds`（`syncUrl` 由 state 变化驱动，dispatch 后自动同步），面板收起，空态回到 `never-run`。

---

## 二、需求 B：「已生成想法」从组合想法移到击穿测试

### B1 组合想法视图只留主流程
删除 `IdeaResults`（原 615–744 行），替换为 **`IdeaOutcomeSummary`**：
- 不再渲染任何 `data-idea-card`（**验收 4**）
- 保留问题 4 建立的三态判定：`never-run` / `ran-empty` / `has-ideas`（挂在 `data-idea-empty` 上）
- 概览标题改为「本次生成产出」，并注明"想法列表现已移到击穿测试视图"

### B2 生成成功后给轻量提示 + 跳转入口
在 `ActionBar` 上加了可选的 `action` 插槽（`{ label, onClick, testId }`），生成成功后反馈条右侧出现 **「去击穿测试 →」**（`data-action-link="goto-crashtest"`）。组合想法视图的产出概览里也有一个常驻入口（`data-goto-crashtest`）。

### B3 击穿测试新增「已生成想法」列表
新建 `src/components/lab/CrashRunBar.tsx`：
- `data-crash-run-bar` —— 容器
- `data-crash-idea-option={id}` + `data-picked` —— 每个可选想法
- `data-run-crash` —— 运行按钮
- `data-run-crash-hint` —— 未选提示
- `data-crash-ideas-empty` + `data-goto-idea` —— 空态与引导出口

结果与所选想法绑定：运行走 `crashTestAction(ideaId)`（`CrashTest.ideaId` 是 `@unique`，本就是单想法语义）；多选时逐个 `await`，能把"哪一个失败"如实报出来。

### B4 未选想法时运行按钮置灰
`disabled` + `aria-disabled` + 文案「请先选择至少一个已生成想法」。

### B5 无想法时的空态
`views.ts` 的 `crashtest` 分支现在按两段判断：
- **连想法都没有** → 「还没有可击穿的想法」，引导**先去组合想法**（在这里点运行是徒劳的，没有靶子）
- **有想法、还没测** → 「还没对任何想法做击穿测试」，就地引导选一个跑起来

### B6 生成的想法立即出现
生成 → 跳转击穿测试，列表条数与 `data-idea-count` 一致（实测 2 vs 2）。

### B7 重置清选中不清想法本体
`resetRun` 清 `crashIdeaIds`；想法本体的删除只发生在二级重置（`resetUserDataAction`）。

### B8 两视图跳转保持上下文
选中集合提升为 `LabShell` state → 写进 URL（`?crashIdeaIds=a,b`），`readUrl` 逐个校验存在性。刷新 / 分享链接 / 视图往返都不丢。

---

## 三、关键实现点

### 3.1 `resetUserDataAction`：Surgery 没有 `projectId`
⏳ **这是计划里标红的"实现前必读"项**。`prisma/schema.prisma:152-173` 确认 `Surgery` 的字段是
`id / methodId / title / description / createdAt / result / verdict / evidenceIds / evidenceStatus`，**没有 `projectId`**。

所以删除必须走关联路径 —— 与 `src/app/projects/[pid]/lab/page.tsx:60-64` 的查询口径一致：

```ts
await prisma.surgery.deleteMany({ where: { method: { paper: { projectId } } } })
```

删除顺序沿用 `scripts/reset-user-data.mjs` 的纪律（先关联表、再主表）：
`crashTest → candidateIdeaDebt → candidateIdea → surgery`。
`SurgeryLog` 由 `Surgery` 级联删除；`CrashTest` 由 `CandidateIdea` 级联。库里**没有任何日志/消息表**，所以需求 A.2 的"清空击穿结果"不牵涉其他表。

### 3.2 `crashIdeaIds` 的六个改动点
`State` / `Action`（含 `syncFromUrl` 载荷）/ `initState` / `readUrl` / `syncFromUrl` reducer 字面量 / `syncUrl` 写出。
`readUrl` 的返回被 `...fromUrl` spread 到**两个** dispatch 点（挂载 hydration + popstate），所以新增字段自动穿透。

### 3.3 `CrashRunBar` 的布局纪律（验收 1 / 2 的结构性保证）
它是画布列（`flex-col`、带 `border-r`）里的**静态 `shrink-0` flex 兄弟**，紧挨 `<BottomPanel>` 上方。
**绝不能**用 `absolute`/`fixed` —— 那会逃出文档流盖住右栏，零重叠验收直接失败。高度也必须收敛（不是 `flex-1`），否则会把画布挤没；列表超过一行走横向/内部滚动。

---

## 四、修掉一个**既有**控制台告警（回归连带）

全量回归里有一条「P7-5 回归：全程无控制台报错」。跑出来是 FAIL：

```
Warning: Updating border borderLeft ... don't mix shorthand and non-shorthand
properties for the same value
    at button ... at CanvasStage (CanvasStage.tsx)
```

**根因**：`CanvasStage.tsx` 列表行按钮在同一个 `style` 对象里同时写了 shorthand `border`（选中 `2px` ↔ 未选中 `1px`，值会变）与 longhand `borderLeft`（3px 状态色条，恒定）。React 在 rerender 时检测到简写覆盖长写，发告警。

**修法**：把 `border` 拆成 `borderTop`/`borderRight`/`borderBottom` 三条长写，四条边互不覆盖，视觉完全一致。

> ⚠️ 这是**既有代码**的问题（非本次需求引入），但既然它是验收项，就一并修掉 —— 否则"修完两个问题反而多一条 FAIL"说不过去。

---

## 五、验收结果

| 套件 | 结果 |
|---|---|
| `scripts/verify-local.py`（全量回归） | **206 / 206 全部通过** ✅（Phase-1 为 198，+8 条需求B 断言） |
| `scripts/verify-p2-reset-and-crash-list.py`（需求A/B 专项） | **36 / 36 全部通过** ✅ |
| `scripts/verify-panel-toolbar.py`（零重叠） | **3 / 3 视口 PASS** ✅（1440/1280/1024） |
| `npx tsc --noEmit` | 无错误 ✅ |
| `pnpm build` | 成功 ✅ |

### 验收标准逐条对照

| # | 标准 | 结果 |
|---|---|---|
| 1 | 面板右边缘 ≤ 右栏左边缘，零重叠 | ✅ 三视口 `panel.right - toolbar.left = -10px`，重叠宽度 0 |
| 2 | 面板收起后右栏位置/宽度/可点区不受影响 | ✅ 右栏宽度仍由外层固定，新按钮均为 `shrink-0` 行内按钮 |
| 3 | 重置确认后回初始态；再次运行可正常生成；基础数据不丢 | ✅ 论文 3 / DNA 3 / 模块 39 / 关系 3 / 债务 4 全部保留 |
| 4 | 组合想法不再出现「已生成的想法」列表 | ✅ 且 `[data-idea-card]` 计数为 0 |
| 5 | 生成 2 个想法后击穿测试列表能看到并选择运行 | ✅ 列表 2 vs 概览 2 |
| 6 | 未选想法时按钮置灰并有提示；无想法时显示空态 | ✅ `disabled=True` + 「请先选择至少一个已生成想法」 |
| 7 | 全流程走通无报错 | ✅ 生成 → 跳转 → 选想法 → 运行 → 看报告，零 console 错误 |

---

## 六、改动文件清单

**新增**
- `src/components/lab/ConfirmDialog.tsx`
- `src/components/lab/CrashRunBar.tsx`
- `scripts/verify-p2-reset-and-crash-list.py`

**修改**
- `src/lib/actions/p4-actions.ts` —— 新增 `resetUserDataAction`
- `src/components/lab/LabShell.tsx` —— state/action/reducer/URL 序列化、4 个新 handler、两处挂载、确认框
- `src/components/lab/RightToolbar.tsx` —— 重置按钮 + 两个 props
- `src/components/lab/ActionBar.tsx` —— 可选 `action` 插槽
- `src/components/lab/IdeaWorkbench.tsx` —— 删 `IdeaResults`，换 `IdeaOutcomeSummary`
- `src/lib/lab/views.ts` —— 击穿空态两段文案
- `src/components/lab/CanvasStage.tsx` —— 修 shorthand/longhand 混用告警
- `scripts/verify-local.py` —— 迁移 7 处 `[data-idea-card]`、4 处「已生成的想法」断言，新增 8 条需求B 断言

---

## 七、遗留与说明

1. **`EvidenceRef` 计数**：当前基线为 **388**。此前文档里记的是 211 / 311 —— 该数字随论文重新抽取而变化，若你要的是某个特定快照值，请指出以哪个为准。
2. **`onSelectIdea` 参数保留**：需求 B 后组合想法视图不再渲染想法卡片，该回调不再被调用。保留参数是为不改动调用方签名之外的其他用法；`tsc` 的 `noUnusedParameters` 未开启，保留安全。
3. **四个设计决策按我的推荐执行**（用户此前未作答）：两级重置 / 保留面板里原有的「运行击穿测试」按钮 / 一级重置不切视图 / 重置按钮放右栏顶部。均可随时推翻。
4. **二级重置不可撤销**：确认框里已明示。它会真的删库（想法 / 击穿 / 手术），但基础数据不动。
