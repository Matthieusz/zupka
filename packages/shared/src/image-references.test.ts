import { Effect, Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { ContentTypeDefinition, DraftData, ImageId } from "./content.js";
import {
  extractImageReferences,
  InvalidImageReference,
  managedImageUrl,
} from "./image-references.js";

const id = Schema.decodeSync(ImageId)("550e8400-e29b-41d4-a716-446655440000");

const second = Schema.decodeSync(ImageId)("550e8400-e29b-41d4-a716-446655440001");

const type = Schema.decodeSync(ContentTypeDefinition)({
  id: "notes",
  label: "Notes",
  fields: [
    { id: "picture", label: "Picture", kind: "image", required: false },
    { id: "custom-markdown", label: "Custom Markdown", kind: "markdown", required: false },
    { id: "plain", label: "Plain", kind: "text", required: false },
  ],
});

const extract = (markdown: string) =>
  extractImageReferences(
    type,
    Schema.decodeSync(DraftData.fields.content)({
      title: "Test",
      slug: "test",
      fields: { "custom-markdown": markdown },
    }),
  );

it("extracts inline, nested, escaped and reference-style CommonMark images, including custom fields", async () => {
  const destination = managedImageUrl(id);
  const source = `> ![inline](${destination})\n\n- [![nested](<${managedImageUrl(second)}>)](https://example.invalid)\n\n![ref][A B]\n\n[A   B]: ${destination}\n`;
  expect(await Effect.runPromise(extract(source))).toEqual([id, second]);
  expect(
    await Effect.runPromise(
      extract(`![entity](/api/images/550e8400-e29b-41d4-a716-44665544000&#48;)`),
    ),
  ).toEqual([id]);
});

it("ignores fenced/inline code, ordinary links, raw HTML, unused definitions and non-Markdown fields", async () => {
  const destination = managedImageUrl(id);
  const source = `\`![code](${destination})\`\n\n\`\`\`md\n![code](${destination})\n\`\`\`\n\n[link](${destination})\n\n<img src="${destination}">\n\n[unused]: ${destination}\n\n![external](https://example.invalid/image.png)`;
  expect(await Effect.runPromise(extract(source))).toEqual([]);
  expect(
    await Effect.runPromise(
      extractImageReferences(
        type,
        Schema.decodeSync(DraftData.fields.content)({
          title: "Plain",
          slug: "plain",
          fields: {
            plain: `![plain](${destination})`,
            picture: { imageId: id, alt: "Snapshot alt" },
          },
        }),
      ),
    ),
  ).toEqual([id]);
});

it("deduplicates references and rejects malformed reserved image destinations", async () => {
  expect(
    await Effect.runPromise(extract(`![a](${managedImageUrl(id)}) ![b](${managedImageUrl(id)})`)),
  ).toEqual([id]);

  for (const url of [
    "/api/images/not-an-id",
    `${managedImageUrl(id)}?bypass=1`,
    "/api/images/../private",
    `/api/imagesX${id}`,
    `/%61pi/images/${id}`,
    `api/images/${id}`,
    `https://cms.invalid/api/images/${id}`,
    `/api/images%2F${id}`,
    `/api//images/${id}`,
    `/api/%2Fimages/${id}`,
  ]) {
    expect(await Effect.runPromise(Effect.flip(extract(`![invalid](${url})`)))).toBeInstanceOf(
      InvalidImageReference,
    );
  }
});
