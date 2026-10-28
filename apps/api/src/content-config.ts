import {
  ContentConfiguration,
  InvalidContentConfiguration,
  parseContentConfiguration,
} from "@zupka/shared";
import { Effect } from "effect";

const commonFields = [
  { id: "summary", label: "Summary", kind: "text", required: false },
  { id: "body", label: "Body", kind: "markdown", required: false },
  { id: "cover-image", label: "Cover image", kind: "image", required: false },
] as const;

/** Built-in Posts; title and slug are required implicitly for every content type. */
export const Posts = {
  id: "posts",
  label: "Posts",
  fields: [
    ...commonFields,
    { id: "publication-date", label: "Publication date", kind: "datetime", required: false },
    { id: "tags", label: "Tags", kind: "text-list", required: false },
  ],
} as const satisfies (typeof ContentConfiguration.Encoded)[number];

/** Built-in Projects; optional portfolio-specific fields can be appended here. */
export const Projects = {
  id: "projects",
  label: "Projects",
  fields: [
    ...commonFields,
    { id: "technologies", label: "Technologies", kind: "text-list", required: false },
    { id: "live-site", label: "Live site", kind: "url", required: false },
    { id: "repository", label: "Repository", kind: "url", required: false },
  ],
} as const satisfies (typeof ContentConfiguration.Encoded)[number];

/** Opt-in example: a custom type using required and defaulted custom fields. */
export const TalksExample = {
  id: "talks",
  label: "Talks",
  fields: [
    { id: "venue", label: "Venue", kind: "text", required: true },
    { id: "duration", label: "Duration (minutes)", kind: "number", required: false, default: 30 },
    { id: "recorded", label: "Recorded", kind: "boolean", required: false, default: false },
    {
      id: "format",
      label: "Format",
      kind: "select",
      required: true,
      choices: ["Conference", "Meetup"],
      default: "Meetup",
    },
  ],
} as const satisfies (typeof ContentConfiguration.Encoded)[number];

/** Parse the deployment's code configuration once at composition; add custom fields/types here.
 * Fails with InvalidContentConfiguration rather than accepting malformed definitions.
 */
export const loadContentConfiguration = parseContentConfiguration([Posts, Projects]).pipe(
  Effect.mapError((cause) => new InvalidContentConfiguration({ cause })),
);
