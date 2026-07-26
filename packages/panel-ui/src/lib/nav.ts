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
