// Admin dashboard: live counts per module, each card linking to its module.
// requireAdmin() comes first (rule 3; the layout doesn't re-run on client
// nav), then getCounts(). Numbers only: nothing restricted or confidential.

import type { Metadata } from "next";
import Link from "next/link";

import {
  ADMIN_SECTIONS,
  type AdminSection,
} from "@/components/admin/admin-sections";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCounts } from "@/lib/admin/dashboard";
import { requireAdmin } from "@/lib/permissions";

// Absolute: the layout's "%s | Admin | YG UniLUX" template only reaches child
// segments, and this page shares the layout's segment.
export const metadata: Metadata = {
  title: { absolute: "Dashboard | Admin | YG UniLUX" },
};

const number = new Intl.NumberFormat("en");

interface Figure {
  label: string;
  value: number;
}

interface DashboardCard {
  section: AdminSection;
  description: string;
  /** The first figure is the headline number; the rest are a breakdown. */
  figures: [Figure, ...Figure[]];
  /** Shows an "Action needed" badge when the headline is above zero. */
  needsAction?: boolean;
}

export default async function AdminDashboardPage() {
  await requireAdmin();
  const counts = await getCounts();

  const cards: DashboardCard[] = [
    {
      section: ADMIN_SECTIONS.products,
      description: "Catalog products",
      figures: [
        { label: "Total", value: counts.products.total },
        { label: "Published", value: counts.products.published },
        { label: "Draft", value: counts.products.draft },
      ],
    },
    {
      section: ADMIN_SECTIONS.categories,
      description: "Product types",
      figures: [
        {
          label: "Total",
          value: counts.categories.main + counts.categories.sub,
        },
        { label: "Main", value: counts.categories.main },
        { label: "Sub", value: counts.categories.sub },
      ],
    },
    {
      section: ADMIN_SECTIONS.areas,
      description: "Application areas",
      figures: [{ label: "Total", value: counts.areas }],
    },
    {
      section: ADMIN_SECTIONS.datasheets,
      description: "Excel files for customers",
      figures: [{ label: "Total", value: counts.datasheets }],
    },
    {
      section: ADMIN_SECTIONS.customers,
      description: "Customer accounts",
      figures: [{ label: "Total", value: counts.customers }],
    },
    {
      section: ADMIN_SECTIONS.accessRequests,
      description: "Waiting for a decision",
      figures: [{ label: "Open", value: counts.openAccessRequests }],
      needsAction: true,
    },
    {
      section: ADMIN_SECTIONS.whistleblower,
      description: "Cases not yet closed",
      figures: [{ label: "Open", value: counts.openWhistleblowerCases }],
      needsAction: true,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <li key={card.section.href}>
            <DashboardCardView card={card} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/*
 * The whole card is clickable through the title link's ::after overlay (one
 * link per card, so screen readers hear it once). The card's ring shows the
 * keyboard focus, because the card clips the link's own outline.
 */
function DashboardCardView({ card }: { card: DashboardCard }) {
  const { section, description, figures, needsAction } = card;
  const [headline, ...breakdown] = figures;
  const Icon = section.icon;

  return (
    <Card className="relative h-full hover:ring-foreground/40 has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring">
      <CardHeader>
        <CardTitle>
          <h2 className="flex items-center gap-2">
            <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
            <Link
              href={section.href}
              className="outline-none after:absolute after:inset-0"
            >
              {section.label}
            </Link>
          </h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Each <div> in the <dl> holds exactly one dt/dd pair (valid HTML);
            the headline takes a full row, the breakdown wraps below it. */}
        <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div className="basis-full">
            <dt className="sr-only">{headline.label}</dt>
            <dd className="flex items-center gap-3">
              <span className="text-3xl font-semibold tabular-nums">
                {number.format(headline.value)}
              </span>
              {needsAction && headline.value > 0 ? (
                <Badge variant="destructive">Action needed</Badge>
              ) : null}
            </dd>
          </div>
          {breakdown.map((figure) => (
            <div key={figure.label} className="flex gap-1.5 text-sm">
              <dt className="text-muted-foreground">{figure.label}</dt>
              <dd className="font-medium tabular-nums">
                {number.format(figure.value)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
