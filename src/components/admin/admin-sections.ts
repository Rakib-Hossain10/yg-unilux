// The admin modules, listed once: the sidebar, the mobile menu and the
// dashboard cards all read their links from here, so a renamed or added
// module changes in one place. Routes without a page yet answer 404.

import {
  Building2,
  FileSpreadsheet,
  FolderTree,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Package,
  Settings,
  ShieldAlert,
  Users,
} from "lucide-react";

export const ADMIN_HOME = "/admin";

export interface AdminSection {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const ADMIN_SECTIONS = {
  dashboard: { href: ADMIN_HOME, label: "Dashboard", icon: LayoutDashboard },
  products: { href: "/admin/products", label: "Products", icon: Package },
  categories: {
    href: "/admin/categories",
    label: "Categories",
    icon: FolderTree,
  },
  areas: { href: "/admin/areas", label: "Areas", icon: Building2 },
  datasheets: {
    href: "/admin/datasheets",
    label: "Datasheets",
    icon: FileSpreadsheet,
  },
  customers: { href: "/admin/customers", label: "Customers", icon: Users },
  accessRequests: {
    href: "/admin/access-requests",
    label: "Access requests",
    icon: Inbox,
  },
  settings: { href: "/admin/settings", label: "Settings", icon: Settings },
  whistleblower: {
    href: "/admin/whistleblower",
    label: "Whistleblower",
    icon: ShieldAlert,
  },
} as const satisfies Record<string, AdminSection>;

/** Sidebar order. */
export const ADMIN_NAV: readonly AdminSection[] = [
  ADMIN_SECTIONS.dashboard,
  ADMIN_SECTIONS.products,
  ADMIN_SECTIONS.categories,
  ADMIN_SECTIONS.areas,
  ADMIN_SECTIONS.datasheets,
  ADMIN_SECTIONS.customers,
  ADMIN_SECTIONS.accessRequests,
  ADMIN_SECTIONS.settings,
  ADMIN_SECTIONS.whistleblower,
];
