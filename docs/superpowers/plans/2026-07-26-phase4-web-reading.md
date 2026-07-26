# Phase 4 Web 阅读与来源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Oren 接入受限 `web.search` / `web.read`：即时通道、按次配额、成功后写入带来源的 `ObservationRecorded`，并投影为可召回的 `external_fact`。

**Architecture:** 新建 `@oren/web`（WebPort + Scripted/Http 适配器 + 内置扩展）。kernel 增加观察事件与 `webQuotaRemaining`。LifeRuntime 在 invoke 包装层做配额预检，并在 web 能力成功后由 LifeActor 提交观察（扩展不写生命史）。记忆投影消费观察事件。真实 Tavily 搜索 + 受限 fetch 阅读为凭据门控手动路径。

**Tech Stack:** TypeScript (ES2024, NodeNext, strict + exactOptionalPropertyTypes), node:sqlite, vitest, fetch, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-26-phase4-web-reading-design.md`

**Search provider (locked):** Tavily (`https://api.tavily.com/search`, env `TAVILY_API_KEY`).

## Global Constraints

- `npm test` / `typecheck` / `build` 全绿且**完全离线**；真实 Web 仅凭据门控手动路径。
- kernel 零依赖；扩展不拥有观察写入权（由运行时/Actor 提交 `ObservationRecorded`）。
- `web.*` traits：`read_only` + `replay_safe` + `billable` → 仍走即时通道。
- 一次成功 search/read → **一条**观察、配额 **-1**；失败不扣配额。
- 旧快照缺 `webQuotaRemaining` 时按 **0**；`createInitialLifeState` 设为 **8**。
- search `limit` 硬顶 **5**；read 正文截断 **8192** 字符；仅 http(s)，禁私网/localhost。
- 测试放各包 `test/*.test.ts`；每任务结束该任务测试 + typecheck 通过再提交。

---

## File map

| Path | Responsibility |
|------|----------------|
| `packages/kernel/src/{protocol,state,reducer,runtime-validation,life-actor}.ts` | Observation + quota |
| `packages/web/**` | Port, safety, adapters, extension |
| `packages/memory/src/memory-index.ts` | Project observations → external_fact |
| `packages/app/src/life-runtime.ts` | Register web, quota gate, record observation |
| `packages/pi-cognition/src/prompts.ts` | 来源与事实纪律 |
| `packages/evals/src/scenarios.ts` | s14/s15 web scenarios |
| `scripts/prepare-dist.mjs` / README | Package link + docs |

---

### Task 1: kernel — webQuota + ObservationRecorded + LifeActor.recordObservation

**Files:**
- Modify: `packages/kernel/src/state.ts`
- Modify: `packages/kernel/src/protocol.ts`
- Modify: `packages/kernel/src/runtime-validation.ts`
- Modify: `packages/kernel/src/reducer.ts`
- Modify: `packages/kernel/src/life-actor.ts`
- Modify: `packages/kernel/src/index.ts` (export any new helpers if added)
- Test: `packages/kernel/test/observation-protocol.test.ts`

**Interfaces:**
- Consumes: existing CoreEvent / LifeState / LifeActor patterns from Phase 3.
- Produces:
  - `LifeState.budgets.webQuotaRemaining?: number` (optional for legacy; new states set 8)
  - `export type ObservationKind = "web_search_result" | "web_page"`
  - CoreEvent member:
    ```ts
    {
      readonly type: "ObservationRecorded";
      readonly observationId: string;
      readonly kind: ObservationKind;
      readonly sourceUrl: string;
      readonly title?: string;
      readonly excerpt: string;
      readonly retrievedAt: string;
      readonly query?: string;
      readonly confidence: number;
    }
    ```
  - `export function webQuotaRemaining(state: LifeState): number` → `state.budgets.webQuotaRemaining ?? 0`
  - `LifeActor.recordObservation(orenId, correlationId, input): { accepted: true } | { accepted: false; reason: string }`
    where `input` omits `observationId`/`type`; actor assigns `observationId` via `nextId()` and commits one event.

- [ ] **Step 1: Write the failing test**

`packages/kernel/test/observation-protocol.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  canonicalizeCoreEvent,
  createInitialLifeState,
  LifeActor,
  reduceLifeState,
  webQuotaRemaining,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";

describe("webQuotaRemaining helper", () => {
  it("defaults missing field to 0 and reads explicit values", () => {
    const base = createInitialLifeState("oren-1", "person-1");
    expect(base.budgets.webQuotaRemaining).toBe(8);
    expect(webQuotaRemaining(base)).toBe(8);
    const legacy = {
      ...base,
      budgets: {
        autonomyRemaining: 0,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    } as LifeState;
    expect(webQuotaRemaining(legacy)).toBe(0);
  });
});

describe("ObservationRecorded", () => {
  it("canonicalizes a valid observation and rejects bad confidence/url/excerpt", () => {
    expect(canonicalizeCoreEvent({
      type: "ObservationRecorded",
      observationId: "o1",
      kind: "web_page",
      sourceUrl: "https://example.com/a",
      excerpt: "正文摘要",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      confidence: 0.7,
    })).toMatchObject({ type: "ObservationRecorded", confidence: 0.7 });

    expect(canonicalizeCoreEvent({
      type: "ObservationRecorded",
      observationId: "o1",
      kind: "web_page",
      sourceUrl: "https://example.com/a",
      excerpt: "x",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      confidence: 1.5,
    })).toBeUndefined();

    expect(canonicalizeCoreEvent({
      type: "ObservationRecorded",
      observationId: "o1",
      kind: "web_search_result",
      sourceUrl: "https://example.com/a",
      excerpt: "x",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      confidence: 0.7,
      // search 缺 query
    })).toBeUndefined();
  });

  it("reducer decrements web quota and rejects when exhausted", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    const envelope: EventEnvelope = {
      eventId: "e1",
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: "2026-07-26T00:00:00.000Z",
      recordedAt: "2026-07-26T00:00:00.000Z",
      source: "test",
      causationId: null,
      correlationId: "c1",
      payload: {
        type: "ObservationRecorded",
        observationId: "o1",
        kind: "web_page",
        sourceUrl: "https://example.com/a",
        excerpt: "hi",
        retrievedAt: "2026-07-26T00:00:00.000Z",
        confidence: 0.7,
      },
    };
    const next = reduceLifeState(state, envelope);
    expect(next.budgets.webQuotaRemaining).toBe(7);
    expect(next.version).toBe(1);

    const exhausted = {
      ...state,
      budgets: { ...state.budgets, webQuotaRemaining: 0 },
    };
    expect(() => reduceLifeState(exhausted, envelope)).toThrow(/web quota/i);
  });
});

describe("LifeActor.recordObservation", () => {
  it("commits ObservationRecorded when quota remains and rejects when exhausted", () => {
    const committed: EventEnvelope[][] = [];
    let state: LifeState = createInitialLifeState("oren-1", "person-1");
    let ids = 0;
    const actor = new LifeActor(
      {
        loadState: () => state,
        commit: (_orenId, events) => {
          committed.push([...events]);
          state = events.reduce(reduceLifeState, state);
        },
        commitIfVersion: () => true,
        commitInbox: () => true,
      },
      () => `id-${++ids}`,
      () => "2026-07-26T00:00:00.000Z",
    );

    const ok = actor.recordObservation("oren-1", "corr-1", {
      kind: "web_search_result",
      sourceUrl: "https://example.com/1",
      title: "搜索：城市步行",
      excerpt: "[1] ...",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      query: "城市步行系统",
      confidence: 0.7,
    });
    expect(ok).toEqual({ accepted: true });
    expect(committed[0]![0]!.payload.type).toBe("ObservationRecorded");
    expect(state.budgets.webQuotaRemaining).toBe(7);

    state = { ...state, budgets: { ...state.budgets, webQuotaRemaining: 0 } };
    const denied = actor.recordObservation("oren-1", "corr-1", {
      kind: "web_page",
      sourceUrl: "https://example.com/2",
      excerpt: "x",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      confidence: 0.7,
    });
    expect(denied).toEqual({ accepted: false, reason: "web_quota_exhausted" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/kernel/test/observation-protocol.test.ts`  
Expected: FAIL (missing exports / types).

- [ ] **Step 3: Implement**

`state.ts` — budgets 增加可选字段；`createInitialLifeState` 设 `webQuotaRemaining: 8`：

```typescript
  readonly budgets: {
    readonly autonomyRemaining: number;
    readonly interactionMaxSteps: number;
    readonly commitmentRemaining: Readonly<Record<string, number>>;
    readonly webQuotaRemaining?: number;
  };
```

```typescript
    budgets: {
      autonomyRemaining: 0,
      interactionMaxSteps: 8,
      commitmentRemaining: {},
      webQuotaRemaining: 8,
    },
```

`protocol.ts` — 在 MemoryKind 附近增加：

```typescript
export type ObservationKind = "web_search_result" | "web_page";
```

`CoreEvent` 联合追加 `ObservationRecorded` 成员（字段同 Interfaces）。

`runtime-validation.ts`：

- 导出或同文件实现 `webQuotaRemaining` 也可放 `state.ts`（推荐 **`state.ts` 导出 `webQuotaRemaining`**）。
- `hasValidLifeStateBudgets`：若 `budgets.webQuotaRemaining !== undefined`，则必须是非负安全整数。
- `canonicalizeCoreEvent` 增加 `ObservationRecorded`：
  - required keys: type, observationId, kind, sourceUrl, excerpt, retrievedAt, confidence
  - optional: title, query
  - `kind === "web_search_result"` 时 **必须** 有非空 `query`
  - `retrievedAt` 经 `canonicalizeInstant`
  - `confidence` 在 [0,1] 有限数
  - `excerpt` / `sourceUrl` / `observationId` 非空；excerpt 长度 ≤ 8192（与 read 截断对齐）

`reducer.ts` — 在 switch 增加：

```typescript
    case "ObservationRecorded": {
      const remaining = state.budgets.webQuotaRemaining ?? 0;
      if (remaining < 1) {
        throw new Error("ObservationRecorded rejected: web quota exhausted");
      }
      return {
        ...base,
        budgets: {
          ...state.budgets,
          webQuotaRemaining: remaining - 1,
        },
      };
    }
```

`life-actor.ts` — 新增方法：

```typescript
  public recordObservation(
    orenId: string,
    correlationId: string,
    input: {
      readonly kind: ObservationKind;
      readonly sourceUrl: string;
      readonly title?: string;
      readonly excerpt: string;
      readonly retrievedAt: string;
      readonly query?: string;
      readonly confidence: number;
    },
  ): { readonly accepted: true } | { readonly accepted: false; readonly reason: string } {
    const current = this.repository.loadState(orenId);
    if ((current.budgets.webQuotaRemaining ?? 0) < 1) {
      return { accepted: false, reason: "web_quota_exhausted" };
    }
    const payload = {
      type: "ObservationRecorded" as const,
      observationId: this.nextId(),
      kind: input.kind,
      sourceUrl: input.sourceUrl,
      excerpt: input.excerpt,
      retrievedAt: input.retrievedAt,
      confidence: input.confidence,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
    };
    // 让 canonicalize 在 commit 路径捕获非法 payload
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, payload),
    ]);
    return { accepted: true };
  }
```

从 `@oren/kernel` 导出 `webQuotaRemaining` 与 `ObservationKind`（`index.ts` 已 `export *` 则自动）。

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/kernel && npm run typecheck`  
Expected: PASS（修复因 LifeState budgets 形状变化导致的测试字面量——凡手写 budgets 缺字段的测试，若触发 `hasValidLifeStateBudgets` 严格路径，按可选字段规则应仍通过）。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel
git commit -m "feat(kernel): add ObservationRecorded and webQuotaRemaining"
```

---

### Task 2: packages/web — types, URL safety, ScriptedWebAdapter

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/src/types.ts`
- Create: `packages/web/src/url-safety.ts`
- Create: `packages/web/src/scripted-adapter.ts`
- Create: `packages/web/src/index.ts`
- Modify: `scripts/prepare-dist.mjs`（加入 `["web", "packages/web"]`）
- Test: `packages/web/test/url-safety.test.ts`
- Test: `packages/web/test/scripted-adapter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const WEB_READ_MAX_CHARS = 8192;
  export const WEB_SEARCH_MAX_RESULTS = 5;
  export const WEB_SEARCH_DEFAULT_LIMIT = 3;

  export interface SearchHit {
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }
  export interface SearchResult {
    readonly results: readonly SearchHit[];
  }
  export interface ReadResult {
    readonly url: string;
    readonly title?: string;
    readonly text: string;
  }
  export interface WebPort {
    search(input: { query: string; limit: number }): Promise<SearchResult>;
    read(input: { url: string }): Promise<ReadResult>;
  }

  export type UrlSafetyResult =
    | { readonly ok: true; readonly href: string }
    | { readonly ok: false; readonly reason: string };

  export function assertSafeHttpUrl(raw: string): UrlSafetyResult;

  export class ScriptedWebAdapter implements WebPort {
    constructor(handlers: {
      search: (query: string, limit: number) => SearchResult | Promise<SearchResult>;
      read: (url: string) => ReadResult | Promise<ReadResult>;
    });
  }
  ```

- [ ] **Step 1: Scaffold package.json + prepare-dist**

```json
{
  "name": "@oren/web",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/extensions": "*",
    "@oren/kernel": "*"
  }
}
```

`prepare-dist.mjs` packages 数组在 memory 后插入 `["web", "packages/web"]`。

- [ ] **Step 2: Failing tests**

`url-safety.test.ts`：允许 `https://example.com/x`；拒绝 `http://127.0.0.1/`、`http://192.168.0.1/`、`http://10.0.0.2/`、`http://172.16.1.1/`、`file:///etc/passwd`、`ftp://x`、`http://localhost/`。

`scripted-adapter.test.ts`：search 把 limit>5 夹到 5；read 把超长 text 截到 8192；私网 url 的 read **抛错或返回失败——约定：ScriptedWebAdapter.read 在 unsafe URL 时 throw Error with reason**（扩展层转 failed）。

- [ ] **Step 3: Implement url-safety + scripted**

`assertSafeHttpUrl`：

1. `new URL(raw)`（失败 → ok:false）
2. protocol 必须 `http:` 或 `https:`
3. hostname 小写后：`localhost`、以 `.localhost` 结尾、或解析为 IP 后落入私网/回环/链路本地 → 拒绝
4. IPv6 `::1` 拒绝
5. 返回 canonical `href`

IP 私网判断用手动解析（不必引入依赖）：点分十进制四段。

`ScriptedWebAdapter`：search 时 `limit = Math.min(Math.max(1, limit), 5)`；对结果每条 url 跑 safety（不安全则过滤掉）；read 先 safety 再调用 handler，再 `text.slice(0, 8192)`。

- [ ] **Step 4: Verify**

Run: `npm install && npx vitest run packages/web && npm run typecheck && npm run build`  
若 lockfile 变更，一并提交。

- [ ] **Step 5: Commit**

```bash
git add packages/web scripts/prepare-dist.mjs package-lock.json
git commit -m "feat(web): add URL safety and ScriptedWebAdapter"
```

---

### Task 3: packages/web — extension + Tavily config + HttpWebAdapter

**Files:**
- Create: `packages/web/src/web-extension.ts`
- Create: `packages/web/src/web-config.ts`
- Create: `packages/web/src/http-adapter.ts`
- Modify: `packages/web/src/index.ts`
- Test: `packages/web/test/web-extension.test.ts`
- Test: `packages/web/test/web-config.test.ts`

**Interfaces:**
- Produces:
  - `createWebExtension(port: WebPort): OrenExtension` — capabilities `web.search`, `web.read`；traits `["read_only","replay_safe","billable"]`；`permissionRequirements: []`；timeoutMs 10_000
  - `WEB_SEARCH_PROVIDER_ENV = "OREN_WEB_SEARCH_PROVIDER"`（仅接受 `"tavily"`）
  - `resolveWebConfig(env) → { ok:true, adapter: WebPort } | { ok:false, kind:"unconfigured"|"invalid", reason }`
  - `HttpWebAdapter` 使用 Tavily search + fetch read；`AbortSignal.timeout(10_000)`；响应体大小上限（如读流截断到 512KiB 再抽文本）

- [ ] **Step 1: Failing extension tests**

- `isImmediateCapability(descriptor)` 对两个能力均为 true（`billable` 不挡即时）。
- search 缺 query → failed invalid_arguments。
- search 成功返回 results；read 成功返回 text。
- Scripted 抛安全错误 → extension invoke status failed。

- [ ] **Step 2: Failing config tests**

- 空 env → unconfigured，reason 含 `OREN_WEB_SEARCH_PROVIDER` 与 `TAVILY_API_KEY`。
- provider=tavily 无 key → invalid。
- provider=tavily + `TAVILY_API_KEY=tvly-test` → ok（**不发网络**）。
- 空白 key 拒绝。

- [ ] **Step 3: Implement extension + config + http adapter**

`web-extension.ts`：解析 arguments；调用 port；catch → failed。

`web-config.ts`：仅 `tavily`；需要 `TAVILY_API_KEY` trim 非空；ok 时 `new HttpWebAdapter({ apiKey, fetchFn?: typeof fetch })`。

`http-adapter.ts`：

- `search`：`POST https://api.tavily.com/search` body `{ api_key, query, max_results: limit }`；映射 results 到 `{ title, url, snippet: content|snippet }`；每条 url safety 过滤。
- `read`：safety → `fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "OrenWebReader/1.0" } })` → 若非 ok throw；读 text（限制大小）→ 粗抽取：去 `<script>...</script>`、`<style>...</style>`、标签变空格、压缩空白 → slice 8192。
- 抽取函数纯函数 `extractReadableText(html: string): string` 便于单测（可在同文件或 `html-extract.ts`）。

可选小测试：`extractReadableText("<html><script>x</script><p>你好</p></html>")` 含「你好」不含 `x`。

- [ ] **Step 4: Verify**

Run: `npx vitest run packages/web && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): add web.search/read extension and Tavily-gated HTTP adapter"
```

---

### Task 4: memory — project ObservationRecorded → external_fact

**Files:**
- Modify: `packages/memory/src/memory-index.ts`
- Test: `packages/memory/test/observation-projection.test.ts`

**Interfaces:**
- Consumes: Task 1 `ObservationRecorded`.
- Produces: projection side effect only — `memoryId = mem:${eventId}`，kind `external_fact`，text 格式：
  - search: `来源观察（搜索「${query}」）：${excerpt}`
  - page: `来源观察（${title ?? sourceUrl}）：${excerpt}`
  - confidence 来自事件；sourceEventId = eventId。

- [ ] **Step 1: Failing test**

投影一条 `ObservationRecorded` web_page 后 `recall({ kinds:["external_fact"] })` 命中；rebuild 一致。

- [ ] **Step 2: Implement** `case "ObservationRecorded":` in `projectEnvelope`.

- [ ] **Step 3: Verify** `npx vitest run packages/memory && npm run typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/memory
git commit -m "feat(memory): project ObservationRecorded into external_fact memories"
```

---

### Task 5: app — LifeRuntime web wiring (quota gate + record observation)

**Files:**
- Modify: `packages/app/package.json`（依赖 `@oren/web`）
- Modify: `packages/app/src/life-runtime.ts`
- Modify: `packages/app/src/index.ts`（如需导出测试辅助）
- Test: `packages/app/test/life-runtime-web.test.ts`

**Interfaces:**
- Consumes: `createWebExtension`, `ScriptedWebAdapter`, `resolveWebConfig`, `webQuotaRemaining`, `LifeActor.recordObservation`.
- Produces:
  - `LifeRuntimeOptions.webPort?: WebPort`
  - `LifeRuntimeOptions.useProcessWebEnv?: boolean`（默认 false；仅 true 时 `resolveWebConfig(process.env)`）
  - 注册策略：若 `webPort` 提供，或 `useProcessWebEnv && resolve ok`，则注册 web 扩展；否则不注册。
  - invoke 包装：
    1. 若 capability 为 `web.search`|`web.read` 且 `webQuotaRemaining(state)<1` → `{ kind:"rejected", reason:"web_quota_exhausted" }`（不调 broker）
    2. 否则 `broker.invoke(...)`
    3. 若结果 `completed` 且能力为 web.* → 构造观察字段并 `actor.recordObservation(...)`；若 record 失败（竞态耗尽）仍返回工具结果但应尽量避免（预检已做）；测试覆盖预检路径即可
    4. 观察 excerpt：search 用 `formatSearchExcerpt(results)`；read 用 `text.slice(0, 8192)`；search 的 sourceUrl = 第一条结果 url，若无结果则 **不写观察、不扣配额**（仍可返回空 results 给模型）

Helper（可放 `packages/app/src/web-observation.ts`）：

```typescript
export function formatSearchExcerpt(results: readonly { title: string; url: string; snippet: string }[]): string
export function observationFromSearch(query: string, results: ...): { kind:"web_search_result"; ... } | null
export function observationFromRead(result: { url: string; title?: string; text: string }): { kind:"web_page"; ... }
```

confidence 固定 `0.7`；`retrievedAt` 用 runtime `now()`。

- [ ] **Step 1: Failing integration tests**

`life-runtime-web.test.ts`：

1. Scripted webPort：自定义 cognition 调 `web.search` 再 `web.read` → drain 后 `inspect().budgets.webQuotaRemaining` 减 2；memory.recall kinds external_fact 非空；重启后仍在。
2. 配额改为 0（通过先耗尽或构造）：再调 web.search → rejected `web_quota_exhausted`，配额仍为 0。
3. 未提供 webPort 且未 useProcessWebEnv → capabilities 无 `web.search`。

实现 cognition 可用内联 ScriptedCognitionAdapter / 自定义 CognitionPort。

注意：`initialize` 后 state 自带 webQuota 8（来自 createInitialLifeState）。若现有测试断言 budgets 精确相等，更新期望包含 `webQuotaRemaining: 8`。

- [ ] **Step 2: Implement LifeRuntime changes**

在 `create()`：

```typescript
const resolvedWeb = options.webPort === undefined && options.useProcessWebEnv === true
  ? resolveWebConfig(process.env)
  : undefined;
const webPort = options.webPort
  ?? (resolvedWeb?.ok ? resolvedWeb.adapter : undefined);
```

extensions 数组：若 `webPort` 定义则 `createWebExtension(webPort)` push。

替换 capabilityPort.invoke 为 async 包装（见上）。`exactOptionalPropertyTypes` 下注意 optional 字段展开。

- [ ] **Step 3: Fix any budget snapshot assertions across app tests**

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`  
Also: `OREN_WEB_SEARCH_PROVIDER=tavily TAVILY_API_KEY=fake npx vitest run packages/app` 必须绿且不访问网络（因默认 `useProcessWebEnv` false）。

- [ ] **Step 5: Commit**

```bash
git add packages/app package-lock.json
git commit -m "feat(app): wire web search/read with quota gate and ObservationRecorded"
```

---

### Task 6: prompts, evals, README

**Files:**
- Modify: `packages/pi-cognition/src/prompts.ts`
- Test: `packages/pi-cognition/test/provenance-prompts.test.ts`
- Modify: `packages/evals/src/scenarios.ts`
- Test: `packages/evals/test/web-scenarios.test.ts`
- Modify: `README.md`
- Optional: `packages/app/src/smoke-runner.ts` — 若配置了 web env，断言至少一条 external_fact 或 observation 后配额减少（保持无凭据时 exit 0）

**Interfaces:**
- Prompts：`## 来源与事实` 段落，含 `web.search` / `web.read`、观察≠结论、引用须带来源。
- Scenarios：
  - `s14-web-search-grounding`：frame 含 WEB_SEARCH + WEB_READ descriptors；trigger 问需要外部资料的问题；assert 调用了 `web.search`，ExpressToUser 含来源线索（url 片段或「来源」「根据」等）。
  - `s15-web-quota-exhausted`：trigger 说明网络配额已用尽；capabilities 仍列出 web.*；capabilityScript 对 web.* 返回 rejected；assert **没有**成功的 web 调用（invocations 中 web 可为 0，或仅被拒），且 completed 合法提议（NoAction 或说明受限的 ExpressToUser）。

- [ ] **Step 1: Failing prompt + scenario structure tests**

- [ ] **Step 2: Implement prompts + scenarios + README section**

README 要点：

```markdown
## Web 阅读（Phase 4）

- `web.search` / `web.read`：受限检索与阅读；成功后写入 ObservationRecorded 并消耗 webQuotaRemaining。
- 离线默认不注册真实 web；测试注入 ScriptedWebAdapter。
- 启用真实路径：
  export OREN_WEB_SEARCH_PROVIDER=tavily
  export TAVILY_API_KEY=...
  # LifeRuntime 需 useProcessWebEnv: true（smoke 在配置齐全时开启）
```

smoke：当 `resolveWebConfig(env).ok` 时 `useProcessWebEnv: true` 并在成功路径断言 `webQuotaRemaining < 8` 或 external_fact 可召回；未配置 web 时行为与现网一致。

- [ ] **Step 3: Full gate**

Run: `npm test && npm run typecheck && npm run build && node --enable-source-maps dist/packages/app/src/demo.js`  
Run: `npm run smoke`（无模型凭据 → exit 0）

- [ ] **Step 4: Commit**

```bash
git add packages/pi-cognition packages/evals packages/app README.md
git commit -m "feat: add provenance prompts, web eval scenarios, and web docs"
```

---

## Self-Review

1. **Spec coverage:** §3–4 kernel/事件/配额 → T1；§5 web 包/安全/适配器/扩展/Tavily → T2–T3；§4.4/§5 记忆投影 → T4；§6 运行时 → T5；§7–8 prompts/evals/验收 → T6。搜索供应商已锁定 Tavily。
2. **Placeholders:** 无 TBD。
3. **Types:** `ObservationKind`、`WebPort`、`recordObservation`、`useProcessWebEnv` 在任务间一致；search 空结果不写观察已写明。
