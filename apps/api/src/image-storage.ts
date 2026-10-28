// @effect-diagnostics unstableApiUsage:off -- Owns managed-image metadata, reference constraints and generated file paths.
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ManagedImage } from "@zupka/contracts";
import {
  ContentTypeDefinition,
  DraftData,
  EntryId,
  ImageId,
  InvalidImageReference,
  MaximumImageBytes,
  extractImageReferences,
  managedImageUrl,
} from "@zupka/shared";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { StorageConfiguration } from "./database.js";

/** Internal failure retains its original cause; HTTP handlers expose only opaque storage errors. */
export class ImageStorageFailure extends Schema.TaggedError<
  ImageStorageFailure,
  { readonly brand: unique symbol }
>()("ImageStorageFailure", { cause: Schema.Defect() }) {}

/** Persisted metadata parser; generated URLs are projected rather than trusted from storage. */
export const ImageRow = Schema.Struct({
  id: ImageId,
  media_type: ManagedImage.fields.mediaType,
  bytes: ManagedImage.fields.bytes,
  width: ManagedImage.fields.width,
  height: ManagedImage.fields.height,
  created_at: ManagedImage.fields.createdAt,
  state: ManagedImage.fields.state,
});

/** Project safe library metadata, without leaking any filesystem path. */
export function imageDto(row: typeof ImageRow.Type): typeof ManagedImage.Type {
  return {
    id: row.id,
    mediaType: row.media_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    state: row.state,
    url: managedImageUrl(row.id),
  };
}

/** Versioned DDL appended to the content migration journal; startup reconciles existing snapshot references. */
export const createImageTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table content_images (
    id text primary key not null, media_type text not null check(media_type in ('image/jpeg','image/png','image/webp','image/gif')),
    bytes integer not null check(bytes > 0 and bytes <= 10485760),
    width integer not null check(width > 0), height integer not null check(height > 0),
    created_at text not null, state text not null check(state in ('active','deleting'))
  )`;
  yield* sql`create index content_images_created on content_images(created_at desc, id)`;
  yield* sql`create table content_image_references (
    entry_id text not null, kind text not null check(kind in ('draft','published')),
    image_id text not null references content_images(id) on delete restrict,
    primary key(entry_id, kind, image_id),
    foreign key(entry_id, kind) references content_snapshots(entry_id, kind) on delete cascade
  )`;
  yield* sql`create index content_image_references_image on content_image_references(image_id)`;
  yield* sql`create trigger content_image_immutable before update of id, media_type, bytes, width, height, created_at on content_images
    begin select raise(abort, 'Image bytes and metadata are immutable'); end`;
  yield* sql`create trigger content_image_delete_referenced before update of state on content_images
    when new.state = 'deleting' and exists(select 1 from content_image_references where image_id = old.id)
    begin select raise(abort, 'Referenced image cannot be deleted'); end`;

  for (const operation of ["insert", "update"] as const) {
    yield* sql.unsafe(`create trigger content_image_reference_${operation} before ${operation} on content_image_references
      when (select state from content_images where id = new.image_id) is not 'active'
      begin select raise(abort, 'Image is unavailable'); end`);
  }
});

const ioFailure = (cause: unknown) => new ImageStorageFailure({ cause }); // oxlint-disable-line anti-slop/no-unknown-parameters -- Filesystem rejection boundary.

/** Check the generated file with O_NOFOLLOW, rejecting symlinks, non-files, and unexpected byte lengths. */
export const checkImageFile = Effect.fn("Images.checkFile")(function* (
  id: typeof ImageId.Type,
  bytes: number,
) {
  const paths = yield* StorageConfiguration;

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        open(
          join(paths.uploadsPath, `${id}.blob`),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ),
      catch: ioFailure,
    }),
    (file) =>
      Effect.tryPromise({
        try: async () => {
          const stat = await file.stat();

          if (!stat.isFile() || stat.size !== bytes || stat.size > MaximumImageBytes)
            throw new Error("Image file mismatch");
        },
        catch: ioFailure,
      }),
    (file) => Effect.promise(() => file.close()),
  );
});

/** Read a bounded immutable file through the same generated, no-follow path; never serve a directory mount. */
export const readImageFile = Effect.fn("Images.readFile")(function* (
  id: typeof ImageId.Type,
  bytes: number,
) {
  const paths = yield* StorageConfiguration;

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        open(
          join(paths.uploadsPath, `${id}.blob`),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ),
      catch: ioFailure,
    }),
    (file) =>
      Effect.tryPromise({
        try: async () => {
          const stat = await file.stat();

          if (!stat.isFile() || stat.size !== bytes || stat.size > MaximumImageBytes)
            throw new Error("Image file mismatch");
          const data = Buffer.alloc(bytes);
          const result = await file.read(data, 0, bytes, 0);

          if (result.bytesRead !== bytes) throw new Error("Incomplete image file");

          return data;
        },
        catch: ioFailure,
      }),
    (file) => Effect.promise(() => file.close()),
  );
});

/** Write a new exclusive file and commit metadata before transferring ownership.
 * Cancellation/failure before commit removes the file; interruption cannot split commit and ownership transfer.
 */
export const storeImageFile = Effect.fn("Images.storeFile")(function* (
  id: typeof ImageId.Type,
  bytes: Uint8Array,
  commit: Effect.Effect<void, ImageStorageFailure, SqlClient.SqlClient>,
) {
  const paths = yield* StorageConfiguration;
  yield* Effect.tryPromise({
    try: () => mkdir(paths.uploadsPath, { recursive: true, mode: 0o700 }),
    catch: ioFailure,
  });
  const path = join(paths.uploadsPath, `${id}.blob`);
  let committed = false;

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(path, "wx", 0o600), catch: ioFailure }),
    (file) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: (signal) => file.writeFile(bytes, { signal }),
          catch: ioFailure,
        });
        yield* Effect.tryPromise({ try: () => file.sync(), catch: ioFailure });
        yield* Effect.uninterruptible(
          commit.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                committed = true;
              }),
            ),
          ),
        );
      }),
    (file) =>
      Effect.promise(async () => {
        try {
          await file.close();
        } finally {
          if (!committed) await unlink(path);
        }
      }),
  );
});

/** Remove only the generated object; absence is retry-safe, other I/O failures remain visible. */
export const removeImageFile = Effect.fn("Images.removeFile")(function* (id: typeof ImageId.Type) {
  const paths = yield* StorageConfiguration;
  yield* Effect.tryPromise({
    try: async () => {
      try {
        await unlink(join(paths.uploadsPath, `${id}.blob`));
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      }
    },
    catch: ioFailure,
  });
});

/** Validate and replace a single snapshot's managed references inside the caller's write transaction.
 * Used by draft saves, startup adoption, explicit data migrations, and subsequent publication transitions.
 */
export const replaceImageReferences = Effect.fn("Images.replaceReferences")(function* (
  entryId: typeof EntryId.Type,
  kind: "draft" | "published",
  type: ContentTypeDefinition,
  content: typeof DraftData.fields.content.Type,
) {
  const ids = yield* extractImageReferences(type, content);
  const sql = yield* SqlClient.SqlClient;

  for (const id of ids) {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ImageRow))(
      yield* sql`select * from content_images where id = ${id} and state = 'active'`,
    );

    const [row] = rows;

    if (!row) return yield* new InvalidImageReference({ reason: "missing-image", imageId: id });
    yield* checkImageFile(id, row.bytes).pipe(
      Effect.catchTag("ImageStorageFailure", () =>
        Effect.fail(new InvalidImageReference({ reason: "missing-image", imageId: id })),
      ),
    );
  }

  yield* sql`delete from content_image_references where entry_id = ${entryId} and kind = ${kind}`;

  for (const id of ids)
    yield* sql`insert into content_image_references(entry_id, kind, image_id) values (${entryId}, ${kind}, ${id})`;
});
