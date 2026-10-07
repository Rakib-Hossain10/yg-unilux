// The admin module list (Server Component). Rendered twice by the admin
// layout: as the desktop sidebar and inside the mobile <details> menu. Only
// the active-link highlight runs on the client (AdminNavLink).

import { AdminNavLink } from "./admin-nav-link";
import { ADMIN_HOME, ADMIN_NAV } from "./admin-sections";

export function AdminNav() {
  return (
    <nav aria-label="Admin">
      <ul className="flex flex-col gap-1">
        {ADMIN_NAV.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <AdminNavLink href={href} exact={href === ADMIN_HOME}>
              <Icon aria-hidden="true" />
              {label}
            </AdminNavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
