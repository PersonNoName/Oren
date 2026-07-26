# Panel UI Next.js Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Next.js three-column warm-observatory panel UI that talks to the existing `@oren/panel` HTTP API so operators can message Oren while inspecting inbox, commitments, grants, budgets, reachability, and ledger.

**Architecture:** New package `packages/panel-ui` (App Router) proxies `/api/*` to `http://127.0.0.1:7465`. Pure TypeScript lib modules (types, API client, chat/thread builders) are unit-tested with Vitest; React components are wired on a single client page. `@oren/panel` API and static `GET /` stay unchanged; README points operators to panel-ui as the recommended surface.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, CSS variables (no UI kit), Vitest (node) for pure helpers, existing `@oren/panel` loopback API.

**Spec:** `docs/superpowers/specs/2026-07-26-panel-ui-redesign-design.md`

## Global Constraints

- Do not modify kernel/storage/cognition business logic or panel API request/response shapes.
- Do not depend on `@oren/panel` from the Next bundle (it pulls Node `http`/`fs`); **mirror** `PanelSnapshot` types in panel-ui.
- Do not replace or rename existing `@oren/web` (channel adapter).
- Panel remains loopback-only; panel-ui does not open non-loopback listeners.
- Keep `@oren/panel` `GET /` old HTML (spec default); do not break `panel-server.test.ts` HTML assertion.
- Exclude `packages/panel-ui` from root `tsconfig.json` compile/`tsc --noEmit` (Next owns that package).
- Vitest tests live under `packages/panel-ui/test/**/*.test.ts` (matches root `vitest.config.ts` include); no React/jsdom tests required in v1.
- Fonts: `next/font/google` — **Source Serif 4** (display) + **Source Sans 3** (body). No Inter/Roboto/Arial as primary.
- Poll interval **2000** ms; default panel upstream `http://127.0.0.1:7465`.
- Work on branch `feat/panel-ui-next` (create from current base if missing).
- Do not edit unrelated roadmap/plan/spec files.

## File map

| File | Responsibility |
|------|----------------|
| `packages/panel-ui/package.json` | `@oren/panel-ui` scripts + Next/React deps |
| `packages/panel-ui/tsconfig.json` | Next TS config |
| `packages/panel-ui/next.config.ts` | `rewrites` proxy `/api/*` → panel |
| `packages/panel-ui/next-env.d.ts` | Next generated types stub |
| `packages/panel-ui/src/lib/panel-types.ts` | Mirrored snapshot + API body types |
| `packages/panel-ui/src/lib/panel-api.ts` | `fetchSnapshot` / mutation helpers |
| `packages/panel-ui/src/lib/chat-messages.ts` | Merge user locals + delivered inbox → chat rows |
| `packages/panel-ui/src/lib/nav.ts` | Nav section ids + labels |
| `packages/panel-ui/test/*.test.ts` | Pure unit tests |
| `packages/panel-ui/src/hooks/usePanelSnapshot.ts` | Poll + refresh + error state |
| `packages/panel-ui/src/components/*.tsx` | Shell, nav, detail views, chat, forms |
| `packages/panel-ui/src/app/layout.tsx` | Fonts + html shell |
| `packages/panel-ui/src/app/page.tsx` | Client panel page |
| `packages/panel-ui/src/app/globals.css` | Warm observatory tokens |
| `tsconfig.json` | Exclude `packages/panel-ui` |
| `package.json` | `"panel-ui"` script |
| `README.md` | Daily use: serve + panel-ui |

---

### Task 1: Scaffold `packages/panel-ui` + root exclusions

**Files:**
- Create: `packages/panel-ui/package.json`
- Create: `packages/panel-ui/tsconfig.json`
- Create: `packages/panel-ui/next.config.ts`
- Create: `packages/panel-ui/next-env.d.ts`
- Create: `packages/panel-ui/src/app/layout.tsx` (minimal)
- Create: `packages/panel-ui/src/app/page.tsx` (placeholder)
- Create: `packages/panel-ui/src/app/globals.css` (minimal tokens)
- Modify: `tsconfig.json` (exclude panel-ui)
- Modify: `package.json` (script)
- Create branch: `feat/panel-ui-next`

**Interfaces:**
- Consumes: none
- Produces: runnable `npm run panel-ui` package; rewrite proxy using `PANEL_URL` env (default `http://127.0.0.1:7465`)

- [ ] **Step 1: Create branch**

```bash
git checkout -b feat/panel-ui-next
```

Expected: on `feat/panel-ui-next`

- [ ] **Step 2: Write package manifests and Next config**

`packages/panel-ui/package.json`:

```json
{
  "name": "@oren/panel-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev --port 3000",
    "build": "next build",
    "start": "next start --port 3000"
  },
  "dependencies": {
    "next": "^15.5.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "typescript": "5.9.3"
  }
}
```

`packages/panel-ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`packages/panel-ui/next.config.ts`:

```ts
import type { NextConfig } from "next";

const panelUrl = (process.env.PANEL_URL ?? "http://127.0.0.1:7465").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${panelUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
```

`packages/panel-ui/next-env.d.ts`:

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

`packages/panel-ui/src/app/globals.css`:

```css
:root {
  --bg: #f7f3ec;
  --bg-chat: #faf7f1;
  --bg-rail: #efe8dc;
  --bg-detail: #f3eee5;
  --ink: #2c2920;
  --muted: #8a8274;
  --line: #d9d0c0;
  --surface: #ffffff;
  --accent: #c2410c;
  --accent-muted: #a8a29e;
  --serif: "Source Serif 4", Georgia, serif;
  --sans: "Source Sans 3", ui-sans-serif, system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
}
```

`packages/panel-ui/src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Source_Sans_3, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const sans = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const serif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Oren Panel",
  description: "Warm observatory panel for Oren",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body style={{
        ["--sans" as string]: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
        ["--serif" as string]: "var(--font-serif), Georgia, serif",
      }}>{children}</body>
    </html>
  );
}
```

`packages/panel-ui/src/app/page.tsx`:

```tsx
export default function Page() {
  return <main style={{ padding: "2rem" }}>Oren panel-ui scaffold</main>;
}
```

- [ ] **Step 3: Exclude panel-ui from root TypeScript project**

In root `tsconfig.json`, add:

```json
"exclude": ["packages/panel-ui", "node_modules", "dist"]
```

(If `exclude` already exists, merge `packages/panel-ui` into it. Keep existing `include`.)

- [ ] **Step 4: Add root script**

In root `package.json` `scripts`:

```json
"panel-ui": "npm run dev -w @oren/panel-ui"
```

- [ ] **Step 5: Install deps**

```bash
npm install
```

Expected: `@oren/panel-ui` has `next`/`react`/`react-dom` in workspace install.

- [ ] **Step 6: Smoke Next boot**

```bash
npm run panel-ui
```

Expected: Next listens on `http://localhost:3000` and page shows `Oren panel-ui scaffold`. Stop with Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add packages/panel-ui package.json tsconfig.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(panel-ui): scaffold Next.js package with API rewrite proxy

EOF
)"
```

---

### Task 2: Mirrored types + panel API client (TDD)

**Files:**
- Create: `packages/panel-ui/src/lib/panel-types.ts`
- Create: `packages/panel-ui/src/lib/panel-api.ts`
- Create: `packages/panel-ui/test/panel-api.test.ts`

**Interfaces:**
- Consumes: `fetch` (injectable for tests)
- Produces:
  ```ts
  export type PanelSnapshot = { /* mirror packages/panel/src/types.ts */ };
  export type CommitmentStatus = "active" | "paused" | "done";
  export async function fetchSnapshot(fetcher?: typeof fetch): Promise<PanelSnapshot>;
  export async function postMessage(text: string, fetcher?: typeof fetch): Promise<void>;
  export async function updateCommitment(
    commitmentId: string,
    body: { status: CommitmentStatus; nextStep?: string; reason: string },
    fetcher?: typeof fetch,
  ): Promise<void>;
  export async function revokeGrant(grantId: string, reason: string, fetcher?: typeof fetch): Promise<void>;
  export async function updateReachability(
    policy: PanelSnapshot["reachability"],
    reason: string,
    fetcher?: typeof fetch,
  ): Promise<void>;
  ```

- [ ] **Step 1: Write failing tests**

`packages/panel-ui/test/panel-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  fetchSnapshot,
  postMessage,
  revokeGrant,
  updateCommitment,
  updateReachability,
} from "../src/lib/panel-api.js";
import type { PanelSnapshot } from "../src/lib/panel-types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptySnap: PanelSnapshot = {
  inbox: [],
  attention: { activeThreadIds: [], currentFocus: null, unresolvedQuestions: [] },
  commitments: [],
  budgets: {
    autonomyRemaining: 0,
    interactionMaxSteps: 8,
    commitmentRemaining: {},
    webQuotaRemaining: 8,
  },
  grants: [],
  schedules: [],
  actionLedger: [],
  publicDiary: [],
  reachability: {
    quietHours: { start: "22:00", end: "08:00", timezone: "UTC" },
    maxProactivePerDay: 3,
    deferWhenQuiet: true,
    proactiveDayKey: null,
    proactiveCountToday: 0,
  },
};

describe("panel-api", () => {
  it("fetchSnapshot GETs /api/snapshot", async () => {
    const fetcher = vi.fn(async () => jsonResponse(emptySnap));
    const snap = await fetchSnapshot(fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/snapshot");
    expect(snap.inbox).toEqual([]);
  });

  it("fetchSnapshot throws on non-OK", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "x" }, 500));
    await expect(fetchSnapshot(fetcher)).rejects.toThrow(/snapshot/i);
  });

  it("postMessage POSTs JSON text", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    await postMessage("hello", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
  });

  it("updateCommitment POSTs to commitment id path", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    await updateCommitment("c1", { status: "paused", reason: "wait" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/commitments/c1", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ status: "paused", reason: "wait" }),
    }));
  });

  it("revokeGrant POSTs reason", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    await revokeGrant("g1", "nope", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/grants/g1/revoke", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "nope" }),
    }));
  });

  it("updateReachability POSTs policy + reason", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    await updateReachability(emptySnap.reachability, "tune", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/reachability", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ policy: emptySnap.reachability, reason: "tune" }),
    }));
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run packages/panel-ui/test/panel-api.test.ts
```

Expected: FAIL (module not found / export missing)

- [ ] **Step 3: Implement types + API**

`packages/panel-ui/src/lib/panel-types.ts` — mirror exactly the fields in `packages/panel/src/types.ts` `PanelSnapshot` (inbox row, attention, commitments, budgets, grants, schedules, actionLedger, publicDiary, reachability). Include:

```ts
export type CommitmentStatus = "active" | "paused" | "done";

export type Commitment = {
  readonly commitmentId: string;
  readonly goal: string;
  readonly status: CommitmentStatus;
  readonly nextStep: string;
  readonly mayAdvanceAutonomously: boolean;
};

export type QuietHours = {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
};

export type ReachabilityPolicy = {
  readonly quietHours: QuietHours | null;
  readonly maxProactivePerDay: number;
  readonly deferWhenQuiet: true;
  readonly proactiveDayKey: string | null;
  readonly proactiveCountToday: number;
};

export type PanelSnapshot = {
  readonly inbox: ReadonlyArray<{
    deliveryId: string;
    text: string;
    reason: string;
    status: "delivered" | "deferred" | "failed";
    proactive?: boolean;
    deferUntil?: string;
    at: string;
  }>;
  readonly attention: {
    readonly activeThreadIds: readonly string[];
    readonly currentFocus: string | null;
    readonly unresolvedQuestions: readonly string[];
  };
  readonly commitments: readonly Commitment[];
  readonly budgets: {
    readonly autonomyRemaining: number;
    readonly interactionMaxSteps: number;
    readonly commitmentRemaining: Readonly<Record<string, number>>;
    readonly webQuotaRemaining?: number;
  };
  readonly grants: ReadonlyArray<{
    grantId: string;
    capabilityPattern: string;
    revoked: boolean;
  }>;
  readonly schedules: ReadonlyArray<{
    scheduleId: string;
    dueAt: string;
    purpose: string;
  }>;
  readonly actionLedger: ReadonlyArray<{ at: string; summary: string }>;
  readonly publicDiary: ReadonlyArray<{ at: string; text: string }>;
  readonly reachability: ReachabilityPolicy;
};
```

`packages/panel-ui/src/lib/panel-api.ts`:

```ts
import type { CommitmentStatus, PanelSnapshot, ReachabilityPolicy } from "./panel-types.js";

async function readOkJson(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = ` ${JSON.stringify(await res.json())}`;
    } catch {
      /* ignore */
    }
    throw new Error(`${label} failed: ${res.status}${detail}`);
  }
  return res.json();
}

export async function fetchSnapshot(fetcher: typeof fetch = fetch): Promise<PanelSnapshot> {
  const res = await fetcher("/api/snapshot");
  return (await readOkJson(res, "snapshot")) as PanelSnapshot;
}

export async function postMessage(text: string, fetcher: typeof fetch = fetch): Promise<void> {
  const res = await fetcher("/api/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  await readOkJson(res, "message");
}

export async function updateCommitment(
  commitmentId: string,
  body: { status: CommitmentStatus; nextStep?: string; reason: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const payload: Record<string, string> = { status: body.status, reason: body.reason };
  if (body.nextStep !== undefined) payload.nextStep = body.nextStep;
  const res = await fetcher(`/api/commitments/${encodeURIComponent(commitmentId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await readOkJson(res, "commitment");
}

export async function revokeGrant(
  grantId: string,
  reason: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const res = await fetcher(`/api/grants/${encodeURIComponent(grantId)}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  await readOkJson(res, "revoke");
}

export async function updateReachability(
  policy: ReachabilityPolicy,
  reason: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const res = await fetcher("/api/reachability", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policy, reason }),
  });
  await readOkJson(res, "reachability");
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run packages/panel-ui/test/panel-api.test.ts
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add packages/panel-ui/src/lib/panel-types.ts packages/panel-ui/src/lib/panel-api.ts packages/panel-ui/test/panel-api.test.ts
git commit -m "$(cat <<'EOF'
feat(panel-ui): add mirrored snapshot types and API client

EOF
)"
```

---

### Task 3: Nav + chat message builders (TDD)

**Files:**
- Create: `packages/panel-ui/src/lib/nav.ts`
- Create: `packages/panel-ui/src/lib/chat-messages.ts`
- Create: `packages/panel-ui/test/chat-messages.test.ts`
- Create: `packages/panel-ui/test/nav.test.ts`

**Interfaces:**
- Consumes: `PanelSnapshot` inbox rows
- Produces:
  ```ts
  export type NavSection =
    | "overview" | "inbox" | "commitments" | "grants"
    | "budgets" | "reachability" | "ledger";
  export const NAV_ITEMS: ReadonlyArray<{ id: NavSection; label: string }>;

  export type LocalUserMessage = {
    readonly id: string;
    readonly text: string;
    readonly at: string;
  };
  export type ChatMessage =
    | { readonly kind: "user"; readonly id: string; readonly text: string; readonly at: string }
    | { readonly kind: "oren"; readonly id: string; readonly text: string; readonly at: string; readonly deliveryId: string }
    | { readonly kind: "oren-weak"; readonly id: string; readonly text: string; readonly at: string; readonly status: "deferred" | "failed"; readonly deliveryId: string };

  export function buildChatMessages(
    inbox: PanelSnapshot["inbox"],
    localUserMessages: readonly LocalUserMessage[],
  ): ChatMessage[];
  ```

Rules for `buildChatMessages`:
- Every `localUserMessages` entry → `kind: "user"`.
- Every inbox `delivered` → `kind: "oren"` with `id: deliveryId`.
- Every inbox `deferred`/`failed` → `kind: "oren-weak"`.
- Sort ascending by `at` (ISO string compare).
- Stable: same inputs → same order.

- [ ] **Step 1: Write failing tests**

```ts
// packages/panel-ui/test/chat-messages.test.ts
import { describe, expect, it } from "vitest";
import { buildChatMessages } from "../src/lib/chat-messages.js";

describe("buildChatMessages", () => {
  it("merges user locals and delivered inbox sorted by at", () => {
    const messages = buildChatMessages(
      [
        {
          deliveryId: "d1",
          text: "hi back",
          reason: "share",
          status: "delivered",
          at: "2026-07-26T12:00:02.000Z",
        },
      ],
      [{ id: "u1", text: "hello", at: "2026-07-26T12:00:01.000Z" }],
    );
    expect(messages.map((m) => m.kind)).toEqual(["user", "oren"]);
    expect(messages[0]?.text).toBe("hello");
    expect(messages[1]?.text).toBe("hi back");
  });

  it("marks deferred/failed as oren-weak", () => {
    const messages = buildChatMessages(
      [
        {
          deliveryId: "d2",
          text: "later",
          reason: "quiet",
          status: "deferred",
          at: "2026-07-26T12:00:03.000Z",
          deferUntil: "2026-07-26T20:00:00.000Z",
        },
      ],
      [],
    );
    expect(messages).toEqual([
      {
        kind: "oren-weak",
        id: "d2",
        text: "later",
        at: "2026-07-26T12:00:03.000Z",
        status: "deferred",
        deliveryId: "d2",
      },
    ]);
  });
});
```

```ts
// packages/panel-ui/test/nav.test.ts
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "../src/lib/nav.js";

describe("NAV_ITEMS", () => {
  it("lists observatory sections in order", () => {
    expect(NAV_ITEMS.map((i) => i.id)).toEqual([
      "overview",
      "inbox",
      "commitments",
      "grants",
      "budgets",
      "reachability",
      "ledger",
    ]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run packages/panel-ui/test/chat-messages.test.ts packages/panel-ui/test/nav.test.ts
```

- [ ] **Step 3: Implement**

`packages/panel-ui/src/lib/nav.ts`:

```ts
export type NavSection =
  | "overview"
  | "inbox"
  | "commitments"
  | "grants"
  | "budgets"
  | "reachability"
  | "ledger";

export const NAV_ITEMS: ReadonlyArray<{ id: NavSection; label: string }> = [
  { id: "overview", label: "对话" },
  { id: "inbox", label: "Inbox" },
  { id: "commitments", label: "Commitments" },
  { id: "grants", label: "Grants" },
  { id: "budgets", label: "Budgets" },
  { id: "reachability", label: "Reachability" },
  { id: "ledger", label: "Ledger" },
];
```

`packages/panel-ui/src/lib/chat-messages.ts` — implement `buildChatMessages` per rules above.

- [ ] **Step 4: Run — expect PASS**

```bash
npx vitest run packages/panel-ui/test/chat-messages.test.ts packages/panel-ui/test/nav.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/panel-ui/src/lib/nav.ts packages/panel-ui/src/lib/chat-messages.ts packages/panel-ui/test
git commit -m "$(cat <<'EOF'
feat(panel-ui): add nav sections and chat message builder

EOF
)"
```

---

### Task 4: `usePanelSnapshot` hook + shell layout chrome

**Files:**
- Create: `packages/panel-ui/src/hooks/usePanelSnapshot.ts`
- Create: `packages/panel-ui/src/components/PanelShell.tsx`
- Create: `packages/panel-ui/src/components/NavRail.tsx`
- Create: `packages/panel-ui/src/components/ErrorBanner.tsx`
- Modify: `packages/panel-ui/src/app/globals.css` (layout classes)
- Modify: `packages/panel-ui/src/app/page.tsx` (wire shell with empty panes)

**Interfaces:**
- Consumes: `fetchSnapshot`, `NavSection`, `NAV_ITEMS`
- Produces:
  ```ts
  export function usePanelSnapshot(pollMs?: number): {
    snapshot: PanelSnapshot | null;
    error: string | null;
    refresh: () => Promise<void>;
    refreshing: boolean;
  };
  // default pollMs = 2000
  ```

- [ ] **Step 1: Implement hook**

`usePanelSnapshot.ts` (client): on mount fetch; `setInterval` every `pollMs`; clear on unmount; `refresh` sets `refreshing` and calls `fetchSnapshot`; on failure set `error` string from `Error.message`, keep last good `snapshot`.

- [ ] **Step 2: Implement shell + nav**

`PanelShell.tsx`: CSS grid `160px 340px 1fr`, full viewport height, slots for rail/detail/chat.

`NavRail.tsx` props:

```ts
type Props = {
  active: NavSection;
  onSelect: (section: NavSection) => void;
  inboxCount: number;
};
```

Brand **Oren** (serif). Active item uses `--bg` tint. Inbox shows count badge when `inboxCount > 0`.

`ErrorBanner.tsx`: shows `error` text above detail content when non-null.

- [ ] **Step 3: Wire placeholder page**

`page.tsx` as `"use client"`:
- `useState<NavSection>("overview")`
- `usePanelSnapshot(2000)`
- Render `PanelShell` with `NavRail`, detail placeholder (`active` label + JSON snippet of snapshot or “Loading…”), chat placeholder.

- [ ] **Step 4: Manual check**

With panel API running (`npm run start` or a life with panel), and `npm run panel-ui`:
- Three columns visible, warm colors
- Nav switches active state
- Snapshot data appears after load (or error banner if API down)

- [ ] **Step 5: Commit**

```bash
git add packages/panel-ui/src
git commit -m "$(cat <<'EOF'
feat(panel-ui): add snapshot polling hook and three-column shell

EOF
)"
```

---

### Task 5: Detail pane views (observability)

**Files:**
- Create: `packages/panel-ui/src/components/DetailPane.tsx`
- Create: `packages/panel-ui/src/components/views/OverviewView.tsx`
- Create: `packages/panel-ui/src/components/views/InboxView.tsx`
- Create: `packages/panel-ui/src/components/views/CommitmentsView.tsx`
- Create: `packages/panel-ui/src/components/views/GrantsView.tsx`
- Create: `packages/panel-ui/src/components/views/BudgetsView.tsx`
- Create: `packages/panel-ui/src/components/views/ReachabilityView.tsx`
- Create: `packages/panel-ui/src/components/views/LedgerView.tsx`
- Create: `packages/panel-ui/src/components/StatusRow.tsx`
- Modify: `packages/panel-ui/src/app/page.tsx`

**Interfaces:**
- Consumes: `PanelSnapshot`, `NavSection`
- Produces: detail views; `StatusRow` with left border color by status (`delivered` → `--accent`, `deferred`/`failed` → `--accent-muted`, default ink)

View requirements:
- **OverviewView**: inbox count + last 3 inbox rows; active commitments (status `active`) up to 5; last 5 ledger entries; last 3 `publicDiary` entries (label “Diary”).
- **InboxView**: all inbox rows via `StatusRow` (status, time mono, text, reason).
- **CommitmentsView**: list id/status/goal/nextStep (forms in Task 6).
- **GrantsView**: grantId, pattern, revoked flag (forms in Task 6).
- **BudgetsView**: `<pre>` of `JSON.stringify(budgets, null, 2)` with mono font.
- **ReachabilityView**: `<pre>` of policy JSON (form in Task 6).
- **LedgerView**: list `at` + `summary`.

Shared list item style: white `--surface`, 1px `--line` border, 8px padding, left bar 2px.

- [ ] **Step 1: Implement StatusRow + views + DetailPane switch**

`DetailPane` props: `{ section: NavSection; snapshot: PanelSnapshot | null; error: string | null; children?: React.ReactNode }` — `children` reserved for forms slot from Task 6; for now views only.

- [ ] **Step 2: Wire into page**

Replace detail placeholder with `DetailPane`.

- [ ] **Step 3: Manual check**

Click each nav item; confirm fields match `/api/snapshot` (compare in browser Network tab).

- [ ] **Step 4: Commit**

```bash
git add packages/panel-ui/src/components
git commit -m "$(cat <<'EOF'
feat(panel-ui): add observatory detail views for all snapshot sections

EOF
)"
```

---

### Task 6: Action forms (commitments, grants, reachability)

**Files:**
- Create: `packages/panel-ui/src/components/forms/CommitmentForm.tsx`
- Create: `packages/panel-ui/src/components/forms/RevokeGrantForm.tsx`
- Create: `packages/panel-ui/src/components/forms/ReachabilityForm.tsx`
- Modify: CommitmentsView / GrantsView / ReachabilityView to embed forms
- Modify: `page.tsx` to pass `onMutated: () => refresh()`

**Interfaces:**
- Consumes: `updateCommitment`, `revokeGrant`, `updateReachability`
- Produces: forms that call APIs then `onSuccess()`

Form rules (match old HTML):
- **CommitmentForm**: fields `commitmentId`, `status` select (`active|paused|done`), optional `nextStep`, required `reason`; submit → `updateCommitment`.
- **RevokeGrantForm**: `grantId`, required `reason` → `revokeGrant`.
- **ReachabilityForm**: prefills `maxProactivePerDay` from snapshot; checkbox “Disable quiet hours” sets `quietHours: null` when checked, else keeps existing `quietHours`; required `reason`; builds full policy object spreading current reachability before POST.
- Disable submit while pending; show error string beside form on failure.

- [ ] **Step 1: Implement three forms**

- [ ] **Step 2: Embed under corresponding views**

- [ ] **Step 3: Manual check**

Against a running life: update a commitment, revoke a grant (or attempt with fake id and see error), tweak reachability — confirm snapshot updates in middle pane after refresh.

- [ ] **Step 4: Commit**

```bash
git add packages/panel-ui/src/components
git commit -m "$(cat <<'EOF'
feat(panel-ui): add commitment, grant revoke, and reachability forms

EOF
)"
```

---

### Task 7: ChatPane + Composer + full page wiring

**Files:**
- Create: `packages/panel-ui/src/components/ChatPane.tsx`
- Create: `packages/panel-ui/src/components/Composer.tsx`
- Modify: `packages/panel-ui/src/app/page.tsx`
- Modify: `packages/panel-ui/src/app/globals.css` (chat bubbles, composer, fade)

**Interfaces:**
- Consumes: `buildChatMessages`, `postMessage`, `LocalUserMessage`
- Produces: working chat column

Behavior:
- `localUserMessages` state in page; on send: append `{ id: \`user-${crypto.randomUUID()}\`, text, at: new Date().toISOString() }`, call `postMessage`, then `refresh()`; on failure remove optimistic message and show composer error.
- `ChatPane`: map `buildChatMessages(snapshot?.inbox ?? [], localUserMessages)`; user bubbles right-aligned surface; oren left serif; `oren-weak` lower opacity + status chip.
- Auto-scroll to bottom when messages length changes (`useEffect` + ref).
- Composer: textarea, Enter-to-send (Shift+Enter newline), Send button with loading disable.
- Subtle CSS: `.fade-in { animation: fade .18s ease-out; }` on detail section change.

- [ ] **Step 1: Implement ChatPane + Composer**

- [ ] **Step 2: Wire page end-to-end**

Page owns: `section`, `localUserMessages`, snapshot hook, handlers.

- [ ] **Step 3: Manual acceptance (spec §8)**

1. `npm run start` (model configured) + `npm run panel-ui`
2. Three-column warm UI loads
3. Middle pane sections match snapshot
4. Send message → user bubble appears → delivered reply appears after cognition/delivery
5. Forms still work
6. `npx vitest run packages/panel-ui/test` PASS
7. `npm test` (repo) still PASS — panel HTML test unchanged

- [ ] **Step 4: Commit**

```bash
git add packages/panel-ui
git commit -m "$(cat <<'EOF'
feat(panel-ui): wire chat pane and composer to panel message API

EOF
)"
```

---

### Task 8: README + root docs polish

**Files:**
- Modify: `README.md` (Daily use section)

- [ ] **Step 1: Update Daily use**

Replace/extend the Daily use block to:

````markdown
## Daily use

Keep a local life running with the loopback panel API (real model required):

```bash
set -a && source .env && set +a
npm run start
```

The process prints `http://127.0.0.1:7465/` (API + legacy HTML). Recommended UI:

```bash
npm run panel-ui
```

Open `http://localhost:3000`. Point `PANEL_URL` at a non-default panel port if needed (e.g. `PANEL_URL=http://127.0.0.1:9001 npm run panel-ui`). Ctrl+C stops each process cleanly. Database defaults to `~/.oren/life.db` (`OREN_DB` to override).
````

Keep surrounding README sections intact.

- [ ] **Step 2: Verify root typecheck still works**

```bash
npm run typecheck
```

Expected: PASS (panel-ui excluded).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: recommend panel-ui Next app for daily observatory use

EOF
)"
```

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| New `packages/panel-ui` Next App Router | 1 |
| Three-column layout | 4–7 |
| Warm observatory visual tokens + fonts | 1, 4, 7 |
| Proxy `/api/*` to panel | 1 |
| Mirror types (no `@oren/panel` import) | 2 |
| Nav + all detail sections | 3, 5 |
| Overview with diary slice | 5 |
| Poll 2s + mutation refresh | 4, 6, 7 |
| Chat from delivered + weak deferred/failed | 3, 7 |
| Optimistic user messages | 7 |
| Forms: commitment / revoke / reachability | 6 |
| Keep old `GET /` HTML | (no task — explicit non-change) |
| README daily use | 8 |
| Root tsc exclude | 1, 8 |
| Acceptance criteria §8 | 7 Step 3 |

## Open details locked by this plan

- Fonts: Source Serif 4 + Source Sans 3 via `next/font`
- Optimistic ids: `user-${crypto.randomUUID()}`, session-local only
- `publicDiary`: last 3 in Overview as “Diary”
- panel `GET /`: **retain** legacy HTML

## Self-review notes

- No TBD/TODO placeholders in steps.
- API paths match `packages/panel/src/server.ts`.
- Test include path matches root Vitest `packages/**/test/**/*.test.ts`.
- `updateCommitment` omits `nextStep` key when empty (matches old HTML behavior).
