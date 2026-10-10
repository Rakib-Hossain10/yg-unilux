// Tests for src/models/user.ts: the users model reads documents shaped the way
// Better Auth's MongoDB adapter stores them, and refuses every Mongoose write
// path (ADR 0017: Better Auth owns the collection).

import { beforeEach, describe, expect, it } from "vitest";

import { getDb, mongoose } from "@/lib/db";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { ReadOnlyModelError, UserModel } from "./user";

setupMemoryDb("yg_user_test");

const userId = new mongoose.Types.ObjectId();

/* A user as Better Auth 1.7.7 writes it: ObjectId _id, BSON dates, no __v. */
const storedUser = {
  _id: userId,
  name: "Jane Customer",
  email: "jane@example.com",
  emailVerified: false,
  image: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  role: "customer",
  banned: false,
  banReason: null,
  banExpires: null,
  mustChangePassword: true,
  accessExpiresAt: new Date("2027-04-01T00:00:00Z"),
  company: "Acme Lighting",
  country: "Hong Kong",
  deviceEpoch: 2,
  expiryReminderFor: new Date("2027-04-01T00:00:00Z"),
  invitedAt: new Date("2026-10-01T00:00:00Z"),
  inviteExpiresAt: new Date("2026-10-04T00:00:00Z"),
  passwordSetAt: new Date("2026-10-02T00:00:00Z"),
};

/* The users collection read through the raw driver, bypassing Mongoose. */
const rawUsers = () => getDb().collection("users");

beforeEach(async () => {
  await rawUsers().deleteMany({});
  await rawUsers().insertOne({ ...storedUser });
});

describe("reading users", () => {
  it("reads a Better Auth user with all mirrored fields", async () => {
    const user = await UserModel.findOne({ email: "jane@example.com" }).lean();
    expect(user).toEqual(storedUser);
  });

  it("uses the users collection and ObjectId ids", async () => {
    expect(UserModel.collection.collectionName).toBe("users");
    const user = await UserModel.findById(userId.toHexString()).lean();
    expect(user?._id).toBeInstanceOf(mongoose.Types.ObjectId);
  });
});

describe("writing users through Mongoose is refused", () => {
  const newUser = { name: "Mallory", email: "mallory@example.com" };
  const filter = { email: "jane@example.com" };

  // Every Mongoose write path, as [name, call].
  const writes: Array<[string, () => Promise<unknown>]> = [
    ["Model.create", () => UserModel.create(newUser)],
    ["Model.insertOne", () => UserModel.insertOne(newUser)],
    ["new Model().save", () => new UserModel(newUser).save()],
    ["Model.insertMany", () => UserModel.insertMany([newUser])],
    [
      "Model.bulkWrite",
      () => UserModel.bulkWrite([{ insertOne: { document: newUser } }]),
    ],
    ["Model.bulkSave", () => UserModel.bulkSave([new UserModel(newUser)])],
    ["Model.updateOne", () => UserModel.updateOne(filter, { role: "admin" })],
    ["Model.updateMany", () => UserModel.updateMany(filter, { role: "admin" })],
    ["Model.replaceOne", () => UserModel.replaceOne(filter, newUser)],
    [
      "Model.findOneAndUpdate",
      () => UserModel.findOneAndUpdate(filter, { role: "admin" }),
    ],
    [
      "Model.findByIdAndUpdate",
      () => UserModel.findByIdAndUpdate(userId, { role: "admin" }),
    ],
    [
      "Model.findOneAndReplace",
      () => UserModel.findOneAndReplace(filter, newUser),
    ],
    ["Model.findOneAndDelete", () => UserModel.findOneAndDelete(filter)],
    ["Model.findByIdAndDelete", () => UserModel.findByIdAndDelete(userId)],
    ["Model.deleteOne", () => UserModel.deleteOne(filter)],
    ["Model.deleteMany", () => UserModel.deleteMany({})],
    ["Model.createCollection", () => UserModel.createCollection()],
    [
      "doc.save after a change",
      async () => {
        const user = await UserModel.findOne(filter).orFail();
        user.role = "admin";
        return user.save();
      },
    ],
    [
      "doc.updateOne",
      async () => {
        const user = await UserModel.findOne(filter).orFail();
        return user.updateOne({ role: "admin" });
      },
    ],
    [
      "doc.deleteOne",
      async () => {
        const user = await UserModel.findOne(filter).orFail();
        return user.deleteOne();
      },
    ],
  ];

  it.each(writes)(
    "%s throws ReadOnlyModelError and changes nothing",
    async (_name, write) => {
      await expect(write()).rejects.toBeInstanceOf(ReadOnlyModelError);

      // The collection still holds exactly the one untouched user.
      const all = await rawUsers().find({}).toArray();
      expect(all).toEqual([storedUser]);
    },
  );
});
