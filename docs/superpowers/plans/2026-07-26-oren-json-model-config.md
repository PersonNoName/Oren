# oren.json 模型配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `smoke` / `eval` 能从项目根 `oren.json` 读取默认 `model.provider` / `model.id`，环境变量可覆盖，API key 仍只走 env。

**Architecture:** 在 `@oren/pi-cognition` 新增薄文件加载器（发现 + 校验），扩展 `resolveModelConfig(env, options?)`：默认 `loadFile: true`，合并「文件默认 ← 非空 env 覆盖」，再走现有 provider/model/key 校验。不新建包。

**Tech Stack:** TypeScript, Node `fs`/`path`, vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-26-oren-json-model-config-design.md`

## Global Constraints

- `npm test` / `typecheck` / `build` 全绿且**完全离线**。
- 配置文件**禁止**存放 API key；出现 `apiKey` → `invalid`。
- 优先级：**env 覆盖文件**；无文件无 env → `unconfigured`（与今日兼容）。
- 默认文件名：`oren.json`；路径覆盖：`OREN_CONFIG` 或 `options.configPath`。
- 未知顶层字段 → `invalid`（拒绝静默忽略）。
- 现有纯 env 单测必须在 `loadFile: false` 下保持行为，或使用 `searchFrom` 指向无 `oren.json` 的临时目录，避免误读仓库根文件。

---

## File map

| Path | Responsibility |
|------|----------------|
| `packages/pi-cognition/src/oren-config-file.ts` | `findOrenConfigPath` / `loadOrenConfigFile` / `OrenFileConfig` |
| `packages/pi-cognition/src/model-config.ts` | 合并文件 + env；扩展 `resolveModelConfig` options |
| `packages/pi-cognition/src/index.ts` | 导出新符号 |
| `packages/pi-cognition/test/oren-config-file.test.ts` | 文件加载/校验 |
| `packages/pi-cognition/test/model-config.test.ts` | 合并语义 + 现有用例加 `loadFile: false` |
| `oren.json.example` | 仓库示例（无密钥） |
| `.gitignore` | 忽略 `oren.json` |
| `README.md` | 文档 |

`smoke-runner` / `evals` CLI **无需改调用签名**（默认 `loadFile: true` 即生效）；若 unconfigured 文案变了，更新断言文案的测试即可。

---

### Task 1: 配置文件发现与校验

**Files:**
- Create: `packages/pi-cognition/src/oren-config-file.ts`
- Create: `packages/pi-cognition/test/oren-config-file.test.ts`
- Modify: `packages/pi-cognition/src/index.ts`

**Interfaces:**
- Consumes: Node `fs` / `path`；无其它 Oren 包。
- Produces:
  ```ts
  export const OREN_CONFIG_FILENAME = "oren.json";
  export const OREN_CONFIG_ENV = "OREN_CONFIG";

  export type OrenFileConfig = {
    readonly model: {
      readonly provider: string;
      readonly id: string;
    };
  };

  export function findOrenConfigPath(startDir: string): string | undefined;
  // Walk startDir → parents; return absolute path of first oren.json, else undefined.
  // Stop at filesystem root.

  export function loadOrenConfigFile(
    path: string,
  ): { readonly ok: true; readonly config: OrenFileConfig }
    | { readonly ok: false; readonly kind: "invalid"; readonly reason: string };
  // Read UTF-8, JSON.parse; validate schema; reject unknown top-level keys;
  // reject apiKey at top-level or under model; require non-empty trimmed provider/id.
  ```

- [ ] **Step 1: Write failing tests**

Create `packages/pi-cognition/test/oren-config-file.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findOrenConfigPath,
  loadOrenConfigFile,
} from "../src/oren-config-file.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oren-config-"));
}

describe("findOrenConfigPath", () => {
  it("finds oren.json in an ancestor directory", () => {
    const root = tempDir();
    writeFileSync(join(root, "oren.json"), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
    }));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findOrenConfigPath(nested)).toBe(join(root, "oren.json"));
  });

  it("returns undefined when no oren.json exists", () => {
    expect(findOrenConfigPath(tempDir())).toBeUndefined();
  });
});

describe("loadOrenConfigFile", () => {
  it("loads a valid config", () => {
    const dir = tempDir();
    const path = join(dir, "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toEqual({
      ok: true,
      config: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
    });
  });

  it("rejects unknown top-level fields", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "openai", id: "x" },
      extra: true,
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/unknown|extra/i);
  });

  it("rejects apiKey fields", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "openai", id: "x", apiKey: "sk-nope" },
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/apiKey|API key|environment/i);
    expect(result.reason).not.toContain("sk-nope");
  });

  it("rejects empty provider/id after trim", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "  ", id: "gpt" },
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("rejects malformed JSON", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, "{not-json");
    const result = loadOrenConfigFile(path);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(path);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run packages/pi-cognition/test/oren-config-file.test.ts`  
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `oren-config-file.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const OREN_CONFIG_FILENAME = "oren.json";
export const OREN_CONFIG_ENV = "OREN_CONFIG";

export type OrenFileConfig = {
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
};

export function findOrenConfigPath(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, OREN_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadOrenConfigFile(
  path: string,
): { readonly ok: true; readonly config: OrenFileConfig }
  | { readonly ok: false; readonly kind: "invalid"; readonly reason: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Cannot read Oren config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Validate: object; only allowed top-level key "model";
  // model object with only provider/id (no apiKey); trim non-empty strings.
  // On failure return invalid with reason mentioning path and rule broken.
  // ...
}
```

Implement full validation in the function body (no partial stubs). Export from `index.ts`:

```ts
export * from "./oren-config-file.js";
```

- [ ] **Step 4: Pass tests**

Run: `npx vitest run packages/pi-cognition/test/oren-config-file.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/pi-cognition
git commit -m "$(cat <<'EOF'
feat(pi-cognition): add oren.json discovery and schema validation

Support finding and loading a project-root model config file without
accepting API keys or unknown fields.
EOF
)"
```

---

### Task 2: `resolveModelConfig` 合并文件与 env

**Files:**
- Modify: `packages/pi-cognition/src/model-config.ts`
- Modify: `packages/pi-cognition/test/model-config.test.ts`
- Modify: `packages/app/test/smoke-runner.test.ts` (only if unconfigured assertion text breaks)
- Modify: `packages/evals/test/scenarios.test.ts` (same, if needed)

**Interfaces:**
- Consumes: Task 1 `findOrenConfigPath` / `loadOrenConfigFile` / `OREN_CONFIG_ENV`.
- Produces:
  ```ts
  export type ResolveModelConfigOptions = {
    readonly configPath?: string;
    readonly searchFrom?: string;
    readonly loadFile?: boolean; // default true
  };

  export function resolveModelConfig(
    env: Readonly<Record<string, string | undefined>>,
    options?: ResolveModelConfigOptions,
  ): ModelConfigResult;
  ```

**Merge algorithm:**
1. If `options.loadFile !== false`:
   - `explicit = options.configPath ?? env.OREN_CONFIG?.trim()`
   - If `explicit`: if `!existsSync(explicit)` → `invalid` (“OREN_CONFIG path does not exist: …”); else `loadOrenConfigFile(explicit)`; on load fail return that invalid.
   - Else: `found = findOrenConfigPath(options.searchFrom ?? process.cwd())`; if found, load it; on load fail return invalid.
2. `provider = env[OREN_MODEL_PROVIDER]?.trim() || file?.model.provider`
3. `id = env[OREN_MODEL_ID]?.trim() || file?.model.id`
4. If missing either → `unconfigured` with reason mentioning **both** `oren.json` (`model.provider` / `model.id`) **and** `OREN_MODEL_*`.
5. Else existing provider/model/key checks unchanged (still read API key only from env).

- [ ] **Step 1: Update existing tests to isolate from repo-root file**

In `model-config.test.ts`, change every existing `resolveModelConfig(...)` call to:

```ts
resolveModelConfig(env, { loadFile: false })
```

Keep expectations the same. This prevents a developer’s local `oren.json` from breaking CI/dev tests once the feature lands (and matches Global Constraints).

Also update unconfigured reason expectations: when `loadFile: false`, reason may still mention `oren.json` **or** only env — prefer updating production unconfigured message to always mention both paths, and assert both substrings even with `loadFile: false`.

- [ ] **Step 2: Add merge tests (failing first)**

Append to `model-config.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OREN_CONFIG_ENV } from "../src/oren-config-file.js";

describe("resolveModelConfig file merge", () => {
  it("uses oren.json when env model vars are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "oren-mc-"));
    writeFileSync(join(dir, "oren.json"), JSON.stringify({
      model: { provider: FIXTURE.provider, id: FIXTURE.modelId },
    }));
    const result = resolveModelConfig(
      { [FIXTURE.keyName]: "test-key-not-a-real-secret" },
      { searchFrom: dir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model.id).toBe(FIXTURE.modelId);
  });

  it("lets env override file provider/id", () => {
    const dir = mkdtempSync(join(tmpdir(), "oren-mc-"));
    writeFileSync(join(dir, "oren.json"), JSON.stringify({
      model: { provider: "anthropic", id: "should-not-win" },
    }));
    const result = resolveModelConfig(
      {
        [MODEL_PROVIDER_ENV]: FIXTURE.provider,
        [MODEL_ID_ENV]: FIXTURE.modelId,
        [FIXTURE.keyName]: "test-key-not-a-real-secret",
      },
      { searchFrom: dir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model.id).toBe(FIXTURE.modelId);
  });

  it("returns invalid when OREN_CONFIG points to a missing file", () => {
    const result = resolveModelConfig(
      { [OREN_CONFIG_ENV]: join(tmpdir(), "no-such-oren-config.json") },
      { loadFile: true },
    );
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("unconfigured reason mentions oren.json and env vars", () => {
    const result = resolveModelConfig({}, {
      loadFile: true,
      searchFrom: mkdtempSync(join(tmpdir(), "oren-mc-empty-")),
    });
    expect(result).toMatchObject({ ok: false, kind: "unconfigured" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/oren\.json/i);
    expect(result.reason).toContain(MODEL_PROVIDER_ENV);
    expect(result.reason).toContain(MODEL_ID_ENV);
  });
});
```

- [ ] **Step 3: Run merge tests — expect FAIL** (options ignored / no file merge)

Run: `npx vitest run packages/pi-cognition/test/model-config.test.ts`

- [ ] **Step 4: Implement merge in `model-config.ts`**

Update signature and unconfigured message. Keep `PROVIDER_API_KEY_ENV_VARS` / key resolution unchanged.

Import `existsSync` from `node:fs` for explicit path existence check.

- [ ] **Step 5: Pass all pi-cognition model tests + fix downstream text asserts**

Run:
```bash
npx vitest run packages/pi-cognition/test/model-config.test.ts packages/pi-cognition/test/oren-config-file.test.ts
npx vitest run packages/app/test/smoke-runner.test.ts packages/evals/test/scenarios.test.ts
```

If smoke/evals tests assert old unconfigured wording, update them to accept the new dual hint (must still contain `OREN_MODEL_PROVIDER` / `OREN_MODEL_ID`).

- [ ] **Step 6: Commit**

```bash
git add packages/pi-cognition packages/app/test packages/evals/test
git commit -m "$(cat <<'EOF'
feat(pi-cognition): merge oren.json defaults into resolveModelConfig

Load project model settings from file with env override, while keeping
API keys environment-only.
EOF
)"
```

---

### Task 3: Example、gitignore、README

**Files:**
- Create: `oren.json.example`
- Modify: `.gitignore`
- Modify: `README.md`（「Real-model commands」一节）

**Interfaces:** none new.

- [ ] **Step 1: Add example + gitignore**

`oren.json.example`:
```json
{
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5"
  }
}
```

`.gitignore` add:
```
oren.json
```

（保留 `.env` 规则；不要 ignore `oren.json.example`。）

- [ ] **Step 2: Update README**

In「Real-model commands」section, add after the env export block (or replace as primary):

```markdown
Or create `oren.json` in the project root (see `oren.json.example`):

```json
{
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5"
  }
}
```

Copy: `cp oren.json.example oren.json` then edit. API keys still come from
the provider's env var (never put secrets in `oren.json`).  
`OREN_MODEL_PROVIDER` / `OREN_MODEL_ID` override the file when set.  
`OREN_CONFIG` points at an alternate config path.
```

Keep existing env-only instructions as the override / CI path.

- [ ] **Step 3: Verify**

```bash
npm test
npm run typecheck
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add oren.json.example .gitignore README.md
git commit -m "$(cat <<'EOF'
docs: add oren.json example and model config usage notes

Ignore local oren.json and document file defaults with env override.
EOF
)"
```

---

## Self-review (author)

| Spec requirement | Task |
|------------------|------|
| Schema + reject unknown / apiKey | 1 |
| Discovery + `OREN_CONFIG` | 1–2 |
| env overrides file | 2 |
| unconfigured / invalid semantics | 2 |
| smoke/eval default load | 2 (default `loadFile: true`, no CLI change required) |
| example + gitignore + README | 3 |
| offline tests | 1–3 |

**Placeholder scan:** none.  
**Type consistency:** `OrenFileConfig`, `ResolveModelConfigOptions`, `OREN_CONFIG_ENV` names stable.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-oren-json-model-config.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
**2. Inline Execution** — execute in this session with checkpoints  

Which approach?
