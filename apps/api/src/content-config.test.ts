import { Effect, Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { ContentConfiguration, createDraft, parseEntry } from "@zupka/shared";
import { loadContentConfiguration, Posts, Projects, TalksExample } from "./content-config.ts";

it("provides Posts and Projects with only title/slug required", async () => {
  const types = await Effect.runPromise(loadContentConfiguration);
  expect(types.map((type) => type.id)).toEqual(["posts", "projects"]);
  expect(Posts.fields.map((field) => field.id)).toEqual([
    "summary",
    "body",
    "cover-image",
    "publication-date",
    "tags",
  ]);
  expect(Projects.fields.map((field) => field.id)).toEqual([
    "summary",
    "body",
    "cover-image",
    "technologies",
    "live-site",
    "repository",
  ]);

  for (const type of types) {
    expect(
      await Effect.runPromise(
        parseEntry(type, "publish", { title: "Hello", slug: "hello", fields: {} }),
      ),
    ).toEqual({ title: "Hello", slug: "hello", fields: {} });
  }
});

it("supports custom types and custom fields on built-ins using the same parser", async () => {
  const types = Schema.decodeUnknownSync(ContentConfiguration)([
    {
      ...Posts,
      fields: [
        ...Posts.fields,
        { id: "featured", label: "Featured", kind: "boolean", required: false, default: false },
      ],
    },
    TalksExample,
  ]);

  for (const type of types) {
    const draft = await Effect.runPromise(
      createDraft(type, { title: "Hello", slug: "hello", fields: {} }),
    );

    if (type.id === "posts") expect(draft.fields.featured).toBe(false);
    else {
      expect(draft.fields).toEqual({ duration: 30, recorded: false, format: "Meetup" });
      await Effect.runPromise(
        parseEntry(type, "publish", {
          ...draft,
          fields: { ...draft.fields, venue: "Local meetup" },
        }),
      );
    }
  }
});
