import type { ReactNode } from "react";

type Props = {
  rail: ReactNode;
  detail: ReactNode;
  chat: ReactNode;
};

export function PanelShell({ rail, detail, chat }: Props) {
  return (
    <div className="panel-shell">
      <aside className="panel-rail">{rail}</aside>
      <main className="panel-detail">{detail}</main>
      <section className="panel-chat">{chat}</section>
    </div>
  );
}
