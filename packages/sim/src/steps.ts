export type DurationMs = number;

export type SimStep =
  | { readonly type: "advance"; readonly ms?: DurationMs; readonly to?: string; readonly drain?: boolean }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "restart" }
  | { readonly type: "swapCognition"; readonly scriptId: string }
  | { readonly type: "swapExtension"; readonly version: string }
  | { readonly type: "revokeGrant"; readonly grantId: string; readonly reason: string }
  | { readonly type: "failNetwork"; readonly failing: boolean; readonly targets?: readonly ("web" | "channel")[] }
  | { readonly type: "setReachability"; readonly quietHours: { start: string; end: string } | null; readonly maxProactivePerDay?: number }
  | { readonly type: "checkpoint"; readonly name: string }
  | { readonly type: "assert"; readonly name: string; readonly args?: Record<string, unknown> };
