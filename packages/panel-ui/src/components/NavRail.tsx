import { NAV_ITEMS, type NavSection } from "@/lib/nav";

type Props = {
  active: NavSection;
  onSelect: (section: NavSection) => void;
  inboxCount: number;
};

export function NavRail({ active, onSelect, inboxCount }: Props) {
  return (
    <nav className="nav-rail" aria-label="Panel sections">
      <div className="nav-brand">Oren</div>
      <ul className="nav-list">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`nav-item${active === item.id ? " nav-item-active" : ""}`}
              aria-current={active === item.id ? "page" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <span>{item.label}</span>
              {item.id === "inbox" && inboxCount > 0 ? (
                <span className="nav-badge" aria-label={`${inboxCount} inbox items`}>
                  {inboxCount}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
