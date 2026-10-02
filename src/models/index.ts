// Every Mongoose model in one place. Importing this file compiles all models
// (no database access). The sync-indexes script builds indexes from the
// `indexedModels` list below.

import type { Collection, Schema } from "mongoose";

import { AccessRequestModel } from "./access-request";
import { AreaModel } from "./area";
import { AuditLogModel } from "./audit-log";
import { CategoryModel } from "./category";
import { DatasheetModel } from "./datasheet";
import { DownloadLogModel } from "./download-log";
import { LeaderModel } from "./leader";
import { LoginAttemptModel } from "./login-attempt";
import { ProductModel } from "./product";
import { SiteContentModel } from "./site-content";
import { UserModel } from "./user";
import { WhistleblowerCaseModel } from "./whistleblower-case";

export {
  AccessRequestModel,
  AreaModel,
  AuditLogModel,
  CategoryModel,
  DatasheetModel,
  DownloadLogModel,
  LeaderModel,
  LoginAttemptModel,
  ProductModel,
  SiteContentModel,
  UserModel,
  WhistleblowerCaseModel,
};

/*
 * The registry only needs what every model shares (name, collection, schema,
 * createIndexes), so it uses this small structural type. Code that reads
 * documents imports the specific, fully typed model instead.
 */
export interface RegisteredModel {
  readonly modelName: string;
  readonly collection: Collection;
  readonly schema: Schema;
  createIndexes(): Promise<void>;
}

/** The 11 collections from CLAUDE.md plus the internal `loginAttempts`. */
export const allModels: readonly RegisteredModel[] = [
  ProductModel,
  CategoryModel,
  AreaModel,
  UserModel,
  AccessRequestModel,
  DownloadLogModel,
  DatasheetModel,
  LeaderModel,
  SiteContentModel,
  WhistleblowerCaseModel,
  AuditLogModel,
  LoginAttemptModel,
];

/**
 * The models whose indexes we build. The read-only users model is left out:
 * Better Auth owns that collection and its indexes (added in task 5).
 */
export const indexedModels: readonly RegisteredModel[] = allModels.filter(
  (model) => model !== UserModel,
);
