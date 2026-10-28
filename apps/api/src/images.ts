// @effect-diagnostics unstableApiUsage:off -- Cohesive image workflows use the pinned transactional SQL API.
import {
  ImageInUse,
  ImageInvalid,
  ImageListQuery,
  ImageNotFound,
  ImageTooLarge,
  ManagedImage,
} from "@zupka/contracts";
import { EntryId, ImageId, MaximumImageBytes } from "@zupka/shared";
import { Clock, Effect, Match, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import sharp from "sharp";
import {
  ImageRow,
  ImageStorageFailure,
  imageDto,
  readImageFile,
  removeImageFile,
  storeImageFile,
} from "./image-storage.js";
import { CurrentOwner } from "./owner-http.js";
import { withDatabaseTransaction } from "./database.js";

const storageFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      Schema.is(ImageInvalid)(cause) ||
      Schema.is(ImageTooLarge)(cause) ||
      Schema.is(ImageNotFound)(cause) ||
      Schema.is(ImageInUse)(cause)
        ? cause
        : new ImageStorageFailure({ cause }),
    ),
  );

const row = Effect.fn("Images.row")(function* (id: typeof ImageId.Type) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ImageRow))(
    yield* sql`select * from content_images where id = ${id}`,
  );

  const [image] = rows;

  if (!image) return yield* new ImageNotFound({});

  return image;
});

const dimensionsSchema = Schema.Struct({
  width: ManagedImage.fields.width,
  height: ManagedImage.fields.height,
  pages: Schema.Int.check(Schema.isGreaterThan(0)),
});

const verify = Effect.fn("Images.verify")(function* (bytes: Uint8Array) {
  // Await native decoding even on interruption so admission permits cannot be recycled while native work continues.
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const decoder = yield* Effect.try({
        try: () =>
          sharp(bytes, {
            animated: true,
            failOn: "warning",
            limitInputPixels: 16_777_216,
          }).timeout({ seconds: 5 }),
        catch: () => new ImageInvalid({}),
      });

      const metadata = yield* Effect.tryPromise({
        try: () => decoder.metadata(),
        catch: () => new ImageInvalid({}),
      });

      const mediaType = Match.value(metadata.format).pipe(
        Match.when("jpeg", () => "image/jpeg"),
        Match.when("png", () => "image/png"),
        Match.when("webp", () => "image/webp"),
        Match.when("gif", () => "image/gif"),
        Match.orElse(() => undefined),
      );

      if (mediaType === undefined) return yield* new ImageInvalid({});

      const dimensions = yield* Schema.decodeEffect(dimensionsSchema)({
        width: metadata.width,
        height: metadata.pageHeight ?? metadata.height,
        pages: metadata.pages ?? 1,
      }).pipe(Effect.mapError(() => new ImageInvalid({})));

      if (dimensions.width * dimensions.height * dimensions.pages > 16_777_216)
        return yield* new ImageInvalid({});
      // Full decoding detects truncated/corrupt payloads; this result is discarded, never used to replace uploaded bytes.
      yield* Effect.tryPromise({
        try: () => decoder.raw().toBuffer(),
        catch: () => new ImageInvalid({}),
      });

      return { mediaType, width: dimensions.width, height: dimensions.height };
    }),
  );
});

/** Consume at most 10 MiB of actual bytes, fully verify supported images, and commit immutable private objects.
 * The HTTP adapter bounds concurrent streams/decoders and stream duration before invoking this workflow.
 */
export const uploadImage = Effect.fn("Images.upload")(function* (
  source: Stream.Stream<Uint8Array, ImageInvalid>,
) {
  yield* CurrentOwner;
  const buffer = Buffer.alloc(MaximumImageBytes);
  let size = 0;
  yield* source.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        if (size + chunk.byteLength > MaximumImageBytes) return yield* new ImageTooLarge({});
        buffer.set(chunk, size);
        size += chunk.byteLength;
      }),
    ),
  );

  if (size === 0) return yield* new ImageInvalid({});
  const bytes = buffer.subarray(0, size);
  const verified = yield* verify(bytes);
  const id = yield* Schema.decodeEffect(ImageId)(crypto.randomUUID());
  const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();

  const image = yield* Schema.decodeUnknownEffect(ManagedImage)({
    id,
    ...verified,
    bytes: size,
    createdAt,
    state: "active",
    url: `/api/images/${id}`,
  });

  const sql = yield* SqlClient.SqlClient;

  const commit = sql
    .withTransaction(sql`insert into content_images(id, media_type, bytes, width, height, created_at, state)
    values (${id}, ${image.mediaType}, ${size}, ${image.width}, ${image.height}, ${createdAt}, 'active')`)
    .pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new ImageStorageFailure({ cause })),
    );

  yield* storeImageFile(id, bytes, commit);

  return image;
}, storageFailure);

/** Owner-only immutable metadata; deleting tombstones are visible for explicit cleanup retries. */
export const getImage = Effect.fn("Images.get")(function* (id: typeof ImageId.Type) {
  yield* CurrentOwner;

  return imageDto(yield* row(id));
}, storageFailure);

/** Bounded private image library, with a count and immutable creation-time ordering. */
export const listImages = Effect.fn("Images.list")(function* (query: typeof ImageListQuery.Type) {
  yield* CurrentOwner;
  const limit = query.limit ?? 20;
  const offset = query.offset ?? 0;
  const sql = yield* SqlClient.SqlClient;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ImageRow))(
        yield* sql`select * from content_images order by created_at desc, id asc limit ${limit} offset ${offset}`,
      );

      const totals = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ total: Schema.Int })),
      )(yield* sql`select count(*) as total from content_images`);

      return { items: rows.map(imageDto), total: totals[0]?.total ?? 0, limit, offset };
    }),
  );
}, storageFailure);

/** Read bytes only after current owner admission and active metadata checks, including for HEAD/conditional requests. */
export const imageBytes = Effect.fn("Images.bytes")(function* (id: typeof ImageId.Type) {
  yield* CurrentOwner;
  const image = yield* row(id);

  if (image.state !== "active") return yield* new ImageNotFound({});
  const bytes = yield* readImageFile(id, image.bytes);

  return { image: imageDto(image), bytes };
}, storageFailure);

/** Read only active images referenced by a current published snapshot, without relying on owner credentials.
 * The reference check, metadata decode, and file read share one transaction, serializing visibility changes/deletion.
 * Missing/publicly unavailable images fail alike; the adapter may then try the mandatory owner guard for private access.
 */
export const publicImageBytes = Effect.fn("Images.publicBytes")(function* (
  id: typeof ImageId.Type,
) {
  const sql = yield* SqlClient.SqlClient;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ImageRow))(
        yield* sql`select i.* from content_images i where i.id = ${id} and i.state = 'active' and exists (
        select 1 from content_image_references r join content_snapshots s on s.entry_id = r.entry_id and s.kind = r.kind
        where r.image_id = i.id and r.kind = 'published'
      )`,
      );

      const [image] = rows;

      if (!image) return yield* new ImageNotFound({});
      const bytes = yield* readImageFile(id, image.bytes);

      return { image: imageDto(image), bytes };
    }),
  );
}, storageFailure);

/** Reserve deletion transactionally before unlinking. A failed unlink/final delete leaves a non-referenceable tombstone.
 * Retrying the same ID resumes cleanup, including after restart; no committed snapshot can lose its referenced file.
 */
export const deleteImage = Effect.fn("Images.delete")(function* (id: typeof ImageId.Type) {
  yield* CurrentOwner;
  const sql = yield* SqlClient.SqlClient;
  yield* withDatabaseTransaction(
    Effect.gen(function* () {
      yield* row(id);

      const references = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({ entryId: EntryId, kind: Schema.Literals(["draft", "published"]) }),
        ),
      )(
        yield* sql`select entry_id as entryId, kind from content_image_references where image_id = ${id} order by entry_id, kind`,
      );

      if (references.length > 0) return yield* new ImageInUse({ references });
      yield* sql`update content_images set state = 'deleting' where id = ${id}`;
    }),
  );
  yield* removeImageFile(id);
  yield* sql`delete from content_images where id = ${id} and state = 'deleting'`;

  return { deleted: id };
}, storageFailure);
