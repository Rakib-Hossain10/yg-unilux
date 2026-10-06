// /admin placeholder (Phase 1 exit: "seeded admin logs in; /admin rejects
// non-admins on the server"). The dashboard arrives in Phase 2. The page
// checks requireAdmin() itself as well as the layout (rule 3).

import { requireAdmin } from "@/lib/permissions";

export default async function AdminHomePage() {
  const viewer = await requireAdmin();

  return (
    <section>
      <h1 className="font-display text-4xl font-light">Admin</h1>
      <p className="mt-3 text-grey-600">
        Signed in as {viewer.user.name || viewer.user.email}. The dashboard and
        catalog tools arrive in Phase 2.
      </p>
    </section>
  );
}
