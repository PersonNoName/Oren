# Panel UI 重设计：Next.js 暖色观察台

> 日期：2026-07-26
> 类型：界面设计（spec）
> 状态：已确认
> 上游：用户请求「简约 / 参考 Claude」；`packages/panel` 现有 loopback API
> 基线：Phase 5 渠道与生活面板已落地；当前 UI 为 `packages/panel/src/static/index.html` 粗糙单页
> 分支：待实现计划创建（建议 `feat/panel-ui-next`）

---

## 1. 目标与边界

把生活面板从「堆叠表单控制台」重做成 **Claude 气质的简约暖浅色界面**，同时满足当前阶段对 **实现效果可观察性** 的需求：对话可用，状态信息密度够高。

**范围内**：

1. 新建 Next.js 前端包 `packages/panel-ui`（App Router + TypeScript）；
2. 三栏布局：左 `NavRail` / 中 `DetailPane` / 右 `ChatPane`；
3. 暖色观察台视觉（暖底 + 等宽元数据 + 状态左边条）；
4. 经现有 `@oren/panel` HTTP API 读写，不改业务语义；
5. 开发期代理 `/api/*` 到 panel（避免 CORS）；
6. 可选：panel 的 `GET /` 静态页改为跳转提示或保留极简说明。

**范围外（第一版不做）**：

- 流式输出、WebSocket、SSE；
- 鉴权 / 非 loopback 暴露；
- 把 Next 嵌进 `LifeRuntime` / `npm run start` 同进程；
- 移动端专门布局优化（允许基础可用，不作为验收重点）；
- 重写 panel API、改 snapshot schema、改 kernel；
- 占用或改造现有 `@oren/web`（那是 channel 适配器，不是前端）。

---

## 2. 核心决策（已确认）

| 决策点 | 选择 |
|--------|------|
| 主交互 | 对话始终可见（右侧），但观察优先 → **三栏详情** 而非纯 Claude 双栏 |
| 次级信息 | 常驻窄侧栏导航；选中项在中栏展开详情与操作表单 |
| 主题 | 暖浅色；「暖色观察台」：Claude 暖底 + 等宽时间/状态、左边条色标 |
| 技术栈 | Next.js（App Router）新包，不继续打磨单文件 HTML 为主路径 |
| 集成 | 方案 A：Next 只做 UI；API 仍由 `@oren/panel` 提供 |
| 启动 | `npm run start` 起 life + panel API；另开 `panel-ui` 开发服看界面 |
| 包名 | `packages/panel-ui`（避免与 `@oren/web` 冲突） |

---

## 3. 架构

```text
Browser (localhost:3000)
  └─ packages/panel-ui (Next.js)
       ├─ UI: PanelShell / NavRail / DetailPane / ChatPane
       ├─ rewrite /api/*  ──proxy──►  http://127.0.0.1:7465/api/*
       └─ types: PanelSnapshot（从 @oren/panel 导入或镜像只读）

LifeRuntime (npm run start)
  └─ @oren/panel createPanelServer
       ├─ GET  /api/snapshot
       ├─ POST /api/message
       ├─ POST /api/reachability
       ├─ POST /api/commitments/:id
       ├─ POST /api/grants/:id/revoke
       └─ GET  /  （可改为「请打开 panel-ui」提示，或暂留旧页）
```

### 3.1 硬约束

- Panel 仍只绑定 `127.0.0.1`；写路径语义不变（须经 runtime 受控方法）。
- `panel-ui` 不直连 SQLite，不 import life runtime。
- 现有 panel 服务端测试（含「GET / 返回 HTML」）若改 `GET /`，须同步更新断言。
- 自动测试默认不启 Next；UI 以手工验收为主，API 契约继续由现有 panel/app 测试覆盖。

---

## 4. 信息架构与布局

### 4.1 三栏

| 栏 | 组件 | 职责 |
|----|------|------|
| 左 ~160px | `NavRail` | 品牌「Oren」；导航：对话总览、Inbox、Commitments、Grants、Budgets、Reachability、Ledger；角标（如 inbox 条数） |
| 中 ~300–360px | `DetailPane` | 按当前 nav 渲染列表/JSON/表单；选中项可内嵌操作 |
| 右 flex | `ChatPane` + `Composer` | 对话流 + 发送框；始终可见 |

### 4.2 导航「对话」时的中栏

显示简版总览：inbox 计数与最近几条、active commitments 摘要、ledger 最近若干条——方便一眼扫实现状态，而不关掉对话。

### 4.3 视觉（暖色观察台）

- CSS 变量：暖纸色背景（如 `#f7f3ec` / `#faf7f1`）、暖侧栏（`#efe8dc`）、墨色正文（`#2c2920`）、强调橙石（状态左边条，如 delivered `#c2410c`）。
- 标题可用衬线（如 Georgia / 自选 Google font）；正文无衬线；时间与 status 用等宽。
- 列表项：白底 + 左边条状态色；避免卡片堆叠阴影与紫色渐变。
- 动效克制：栏切换淡入、发送按钮 loading 即可（2–3 处）。

---

## 5. 组件清单

| 组件 | 说明 |
|------|------|
| `PanelShell` | 三栏栅格 + 主题变量 |
| `NavRail` | 区块切换 + 角标 |
| `DetailPane` | 按 section 切换子视图 |
| `InboxView` / `CommitmentsView` / `GrantsView` / `BudgetsView` / `ReachabilityView` / `LedgerView` | 中栏内容 |
| `OverviewView` | 「对话」nav 下的简版总览 |
| `ChatPane` | 气泡列表 |
| `Composer` | textarea + Send |
| `ActionForms` | UpdateCommitment / RevokeGrant / Reachability（嵌在对应详情） |
| `usePanelSnapshot` | fetch snapshot、轮询、mutation 后刷新 |

---

## 6. 数据流与交互

### 6.1 读

- `GET /api/snapshot` 拉全量。
- 默认约 **2s** 轮询；mutation 成功后立即再拉。
- 请求失败：中栏顶部错误条；不卸载对话区。

### 6.2 对话呈现

- **用户消息**：Composer 提交后乐观插入；成功后与后续 snapshot 对齐（不依赖服务端回显用户原文到 inbox）。
- **Oren 回复**：以 `inbox` 中 `status === "delivered"` 的投递文本为回复气泡。
- **deferred / failed**：主展示在中栏 Inbox；对话中可用弱样式或角标提示，避免假造成功回复。
- **`publicDiary` / `actionLedger`**：不进入主对话气泡；分别在对应详情（若 diary 暂无独立 nav，可并入总览或 Ledger 附近说明——第一版以现有 nav 项为准：Ledger 展示 `actionLedger`；diary 若需可见，放在 Overview 折叠区）。

### 6.3 写（API 契约不变）

| 动作 | API |
|------|-----|
| 发消息 | `POST /api/message` `{ text }` |
| 更新承诺 | `POST /api/commitments/:id` `{ status, nextStep?, reason }` |
| 撤销 grant | `POST /api/grants/:id/revoke` `{ reason }` |
| 更新可达性 | `POST /api/reachability` `{ policy, reason }` |

表单均需 `reason`（与现页一致）。提交中禁用按钮；错误展示在表单旁。

### 6.4 环境

- `NEXT_PUBLIC_PANEL_URL`（或 server-only `PANEL_URL`）默认 `http://127.0.0.1:7465`。
- Next `rewrites` 将 `/api/:path*` 转到 panel，浏览器只打同源 `/api/...`。

---

## 7. 包与工程改动

1. 新增 `packages/panel-ui`：`package.json`（`next`、`react`、`react-dom`）、`tsconfig`、`next.config.ts`、`app/layout.tsx`、`app/page.tsx`、`app/globals.css`、组件与 hook 目录。
2. 根 `package.json` workspaces 已含 `packages/*`，一般无需改；可加 script 如 `"panel-ui": "npm run dev -w @oren/panel-ui"`。
3. README「Daily use」补充：起 serve 后另开 panel-ui，并给出 URL。
4. `@oren/panel`：第一版可保留旧 `index.html` 以免打断只开 7465 的用户；或改为短 HTML 提示打开 panel-ui——实现计划里二选一，默认 **保留旧页并在 README 标明推荐入口为 panel-ui**。

---

## 8. 验收标准

1. 在 life + panel 已启动时，打开 panel-ui 可见三栏暖色界面。
2. 中栏可观察 Inbox / Commitments / Grants / Budgets / Reachability / Ledger，数据与 `/api/snapshot` 一致。
3. 右侧可发送消息；发送后 snapshot 刷新，delivered 回复出现在对话区。
4. 承诺更新、grant 撤销、reachability 更新表单可用且与现 API 行为一致。
5. 现有 `npm test` / panel 服务端测试不因本改动无故失败（若改 `GET /` 则测试同步更新）。

---

## 9. 开放实现细节（计划阶段敲定即可）

- 具体字体包（本地 system 衬线 vs `next/font` 引入）。
- 用户消息乐观列表的本地 id 策略与去重。
- `publicDiary` 是否在 Overview 展示一行摘要。
- panel `GET /` 保留旧 UI 或改为跳转文案。
