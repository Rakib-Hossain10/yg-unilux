// Admin settings: which spec columns are restricted, the WhatsApp number and
// the company email. requireAdmin() first (rule 3; the layout doesn't re-run on
// client navigation). There is no geo-block switch: it is an env var (ADR 0003).

import type { Metadata } from "next";

import { ColumnVisibilityForm } from "@/components/admin/settings/column-visibility-form";
import { ContactSettingsForm } from "@/components/admin/settings/contact-settings-form";
import { getAdminSettings } from "@/lib/admin/settings";
import { requireAdmin } from "@/lib/permissions";

// Static only (ADR 0036): a title never carries data.
export const metadata: Metadata = { title: "Settings" };

export default async function AdminSettingsPage() {
  await requireAdmin();
  const settings = await getAdminSettings();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Contact details for the site and which product details only approved
          customers can see.
        </p>
      </div>

      <ContactSettingsForm
        whatsappNumber={settings.whatsappNumber}
        companyEmail={settings.companyEmail}
      />
      <ColumnVisibilityForm initial={settings.columnVisibility} />
    </div>
  );
}
