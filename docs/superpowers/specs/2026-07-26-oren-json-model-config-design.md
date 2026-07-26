# 设计：oren.json 模型配置

> 日期：2026-07-26
> 类型：功能设计（spec）
> 状态：已确认
> 上游：现有 `resolveModelConfig`（`packages/pi-cognition`）、README 真实模型路径
> 基线：`main`（Phase 6 已合入）
> 分支：`feat/oren-json-model-config`

---

## 1. 目标与边界

用项目根 `oren.json` 声明默认模型，使本地使用体验接近常见 agent 产品；API key 仍只走环境变量；现有 `OREN_MODEL_PROVIDER` / `OREN_MODEL_ID` 可临时覆盖文件。

**范围内**：

1. 文件格式、发现规则与校验；
2. `resolveModelConfig` 合并（文件默认 ← env 覆盖）；
3. `smoke` / `eval` 默认启用文件加载；
4. `oren.json.example`、`.gitignore`、`README` 文档。

**范围外**：

embedding / web / panel / 数据库路径写入同一文件；配置文件中的 API key；YAML / TS 配置；多 profile UI。

## 2. 核心决策（已确认）

| 决策点 | 选择 |
|--------|------|
| 范围 | 仅模型（provider + id） |
| 密钥 | 仍走环境变量；文件禁止 `apiKey` |
| 格式与路径 | 项目根 `oren.json`；`OREN_CONFIG` 可覆盖路径 |
| 优先级 | env 覆盖文件 |
| 落位 | 方案 A：扩展 `resolveModelConfig` + 薄文件加载器（`@oren/pi-cognition`） |

## 3. 文件契约

### 3.1 Schema（v1）

```json
{
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5"
  }
}
```

- `model` 必填对象；`provider` / `id` 为非空字符串（trim 后）。
- 未知顶层字段 → **invalid**（拒绝静默忽略）。
- 若出现 `apiKey`（顶层或 `model` 内）→ **invalid**，提示改用对应 provider 的 API key 环境变量。
- JSON 解析失败 → **invalid**，附带路径与原因。

### 3.2 发现顺序

1. 若 `env.OREN_CONFIG`（或 `options.configPath`）非空 → 只用该路径；文件不存在 → **invalid**。
2. 否则从 `options.searchFrom ?? process.cwd()` 起向父目录查找 `oren.json`，找到即停。
3. 都没有 → 「无文件」，仅依赖 env（与今日行为兼容）。

## 4. 合并语义与 API

### 4.1 有效 provider / id

```text
file.model.provider / file.model.id     （若加载到合法文件）
        ↑ 被非空 env 覆盖
OREN_MODEL_PROVIDER / OREN_MODEL_ID
```

之后沿用现有逻辑：校验 known provider / model，并从 provider 对应 env 读取 API key（**不从文件读 key**）。

| 最终状态 | 结果 |
|----------|------|
| provider 与 id 皆有且合法 + 有 key | `ok: true` |
| 缺 provider 或 id | `unconfigured` |
| 文件坏 / 未知字段 / 含 apiKey / `OREN_CONFIG` 指向缺失 / 未知模型等 | `invalid` |

### 4.2 API（`packages/pi-cognition`）

```ts
export type OrenFileConfig = {
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
};

export function findOrenConfigPath(startDir?: string): string | undefined;

export function loadOrenConfigFile(
  path: string,
): { readonly ok: true; readonly config: OrenFileConfig }
  | { readonly ok: false; readonly kind: "invalid"; readonly reason: string };

export function resolveModelConfig(
  env: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly configPath?: string;
    readonly searchFrom?: string;
    readonly loadFile?: boolean; // default true
  },
): ModelConfigResult;
```

- `loadFile` 默认 `true`；单测可设 `false` 以保持纯 env 行为。
- `configPath` 优先于向上查找；未传时尊重 `env.OREN_CONFIG`。

### 4.3 错误文案

- **unconfigured**：说明可写 `oren.json` 的 `model.provider` / `model.id`，或设置 `OREN_MODEL_*`，并提醒配置 provider API key env。
- **含 apiKey**：拒绝并指向该 provider 的 key env 名列表（与现有 missing-key 提示一致风格）。
- **未知字段 / JSON 损坏**：给出路径与具体原因。

## 5. 接入与仓库卫生

- `packages/app/src/smoke-runner.ts`、`packages/evals/src/cli.ts`：继续调用 `resolveModelConfig(env)`（默认加载文件）。
- 自动化测试：对不希望读仓库根 `oren.json` 的用例使用 `loadFile: false`，或在临时目录下以 `searchFrom` 隔离。
- 提交 `oren.json.example`（合法示例，无密钥）。
- `.gitignore` 增加 `oren.json`（与 `.env` 同类）。
- `README.md`：最小示例 + 优先级说明（env > 文件 > 未配置）。

## 6. 测试与验收

1. 仅合法 `oren.json` + 对应 API key env → `resolveModelConfig` 成功（单测可用假 provider 表或现有 fixture）。
2. 文件与 env 同时存在 → env 胜出。
3. 无文件无 env → `unconfigured`；smoke/eval 仍 exit 0。
4. 坏 JSON / 含 `apiKey` / 未知字段 → `invalid`。
5. `OREN_CONFIG` 指向不存在路径 → `invalid`。
6. `npm test` / `typecheck` / `build` 全绿且完全离线。

## 7. 明确不做

- 统一配置 embedding / web / panel（可后续扩 schema，本 Phase 不实现）。
- 把密钥写入 `oren.json`。
- 新建 `@oren/config` 包（YAGNI；本需求用方案 A 足够）。
