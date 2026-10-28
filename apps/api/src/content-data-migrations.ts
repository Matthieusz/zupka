import type { ContentDataMigration } from "./content-storage.js";

/** Operator-authored, sequential data conversions. Never run automatically at service startup.
 * Retain exact source/target definitions in each migration rather than importing mutable current ones.
 * See docs/CONTENT_STORAGE.md for a complete migration example and maintenance procedure.
 */
export const contentDataMigrations: ReadonlyArray<ContentDataMigration> = [];
