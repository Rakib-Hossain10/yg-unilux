// Create a customer by hand (Phase 5 P8, plan Q1): an invite link goes out
// (emailed, or shown once to copy), never a password. requireAdmin() first
// (rule 3); the action re-checks and the service re-checks the actor.

import type { Metadata } from "next";

import { BackLink } from "@/components/admin/back-link";
import { CreateCustomerForm } from "@/components/admin/customers/create-customer-form";
import { CUSTOMERS_PATH } from "@/components/admin/customers/paths";
import { requireAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "New customer" };

export default async function NewCustomerPage() {
  await requireAdmin();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={CUSTOMERS_PATH}>Customers</BackLink>
        <h1 className="text-2xl font-semibold">New customer</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The customer gets an invite link to choose their own password. One
          approval unlocks every datasheet until the end date you pick.
        </p>
      </div>
      <CreateCustomerForm />
    </div>
  );
}
