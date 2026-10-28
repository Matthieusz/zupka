<script lang="ts">
  import type { AdminEntry } from "@zupka/contracts";
  import { managedImageUrl, type ContentTypeDefinition } from "@zupka/shared";
  import MarkdownPreview from "./MarkdownPreview.svelte";

  let {
    content,
    type,
    changed = [],
  }: {
    content: (typeof AdminEntry.Type)["draft"];
    type: ContentTypeDefinition;
    changed?: readonly string[];
  } = $props();
</script>

<div class="snapshot-content">
  <div class="snapshot-field" data-changed={changed.includes("title")}>
    <p class="field-name">
      Title {#if changed.includes("title")}<span>Changed</span>{/if}
    </p>
    <h3>{content.title}</h3>
  </div>
  <div class="snapshot-field" data-changed={changed.includes("slug")}>
    <p class="field-name">
      Slug {#if changed.includes("slug")}<span>Changed</span>{/if}
    </p>
    <p class="plain">/{content.slug}</p>
  </div>
  {#each type.fields as field (field.id)}
    {@const value = content.fields[field.id]}
    <div class="snapshot-field" data-changed={changed.includes(field.id)}>
      <p class="field-name">
        {field.label}
        {#if changed.includes(field.id)}<span>Changed</span>{/if}
      </p>
      {#if value === undefined}<p class="absent">Not included</p>
      {:else if typeof value === "string" && field.kind === "markdown"}
        {#if value}<MarkdownPreview source={value} />{:else}<p class="absent">Empty</p>{/if}
      {:else if typeof value === "object" && "imageId" in value}
        <img src={managedImageUrl(value.imageId)} alt={value.alt} />
        <p class="plain">Alt text: {value.alt || "Empty"}</p>
      {:else if Array.isArray(value)}
        {#if value.length}<ul>
            {#each value as item}<li>{item || "(empty item)"}</li>{/each}
          </ul>
        {:else}<p class="absent">Empty list</p>{/if}
      {:else}<p class="plain">
          {typeof value === "boolean"
            ? value
              ? "True"
              : "False"
            : value === ""
              ? "(empty)"
              : String(value)}
        </p>{/if}
    </div>
  {/each}
  <details>
    <summary>View JSON</summary>
    <pre>{JSON.stringify(content, null, 2)}</pre>
  </details>
</div>

<style>
  .snapshot-content {
    display: grid;
    gap: 1.5rem;
    overflow-wrap: anywhere;
  }
  .snapshot-field {
    display: grid;
    gap: 0.625rem;
  }
  .field-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 500;
  }
  .field-name span {
    color: var(--changed);
    font-size: 0.6875rem;
    background: color-mix(in oklch, var(--changed) 10%, transparent);
    border-radius: var(--radius);
    padding: 0.125rem 0.375rem;
  }
  h3 {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.25;
    font-weight: 600;
    letter-spacing: -0.025em;
  }
  .plain,
  li {
    white-space: pre-wrap;
  }
  .absent,
  summary {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  img {
    max-inline-size: 100%;
    max-block-size: 18rem;
    object-fit: contain;
    justify-self: start;
    border-radius: var(--radius);
  }
  ul {
    margin: 0;
    padding-inline-start: 1.25rem;
    list-style: disc;
  }
  details {
    border-block-start: 1px solid var(--rule);
    padding-block-start: 1rem;
  }
  summary {
    cursor: pointer;
    min-block-size: 2.75rem;
    align-content: center;
  }
  summary:active {
    color: var(--accent);
  }
  pre {
    font-size: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--rail);
    padding: 1rem;
    border-radius: var(--radius);
  }
</style>
