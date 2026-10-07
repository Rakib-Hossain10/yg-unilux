// Who uploaded each datasheet, as a name or email for the list (admin only).
// A read of the read-only users model; listDatasheets() returns the id only.
// Proposed for the service (see the T13 report): then this file can go.

import "server-only";

import { connectDb, mongoose } from "@/lib/db";
import { UserModel } from "@/models";

/** `uploadedBy` id -> "Name" or email; a removed account is simply absent. */
export async function uploaderLabels(
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) =>
    mongoose.Types.ObjectId.isValid(id),
  );
  if (unique.length === 0) return new Map();
  await connectDb();
  const users = await UserModel.find(
    { _id: { $in: unique.map((id) => new mongoose.Types.ObjectId(id)) } },
    { name: 1, email: 1 },
  ).lean<{ _id: mongoose.Types.ObjectId; name?: string; email?: string }[]>();
  return new Map(
    users.map((user) => [
      user._id.toHexString(),
      user.name?.trim() || user.email || "Unknown",
    ]),
  );
}
