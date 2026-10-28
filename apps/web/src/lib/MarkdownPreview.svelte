<script lang="ts">
  import { fromMarkdown } from "mdast-util-from-markdown";
  import { normalizeIdentifier } from "micromark-util-normalize-identifier";
  import type { RootContent } from "mdast";
  import { ImageId, managedImageUrl } from "@zupka/shared";
  import { Result, Schema } from "effect";

  let { source }: { source: string } = $props();

  const tree = $derived(fromMarkdown(source));

  const definitions = $derived.by(() => {
    const result = new Map<string, string>();

    function visit(nodes: ReadonlyArray<RootContent>) {
      for (const node of nodes) {
        if (node.type === "definition") {
          const key = normalizeIdentifier(node.identifier);

          if (!result.has(key)) result.set(key, node.url);
        }

        if ("children" in node) visit(node.children);
      }
    }

    visit(tree.children);

    return result;
  });

  function link(url: string) {
    const parsed = URL.parse(url);

    return parsed && ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : undefined;
  }

  function image(url: string) {
    const parsed = Schema.decodeUnknownResult(ImageId)(url.slice("/api/images/".length));

    return Result.isSuccess(parsed) && url === managedImageUrl(parsed.success) ? url : undefined;
  }
</script>

{#snippet nodes(children: ReadonlyArray<RootContent>)}
  {#each children as node}
    {#if node.type === "text"}{node.value}
    {:else if node.type === "paragraph"}<p>{@render nodes(node.children)}</p>
    {:else if node.type === "heading"}<svelte:element this={`h${node.depth}`}
        >{@render nodes(node.children)}</svelte:element
      >
    {:else if node.type === "strong"}<strong>{@render nodes(node.children)}</strong>
    {:else if node.type === "emphasis"}<em>{@render nodes(node.children)}</em>
    {:else if node.type === "blockquote"}<blockquote>{@render nodes(node.children)}</blockquote>
    {:else if node.type === "list"}
      {#if node.ordered}<ol start={node.start ?? 1}>{@render nodes(node.children)}</ol>{:else}<ul>
          {@render nodes(node.children)}
        </ul>{/if}
    {:else if node.type === "listItem"}<li>{@render nodes(node.children)}</li>
    {:else if node.type === "code"}<pre><code>{node.value}</code></pre>
    {:else if node.type === "inlineCode"}<code>{node.value}</code>
    {:else if node.type === "break"}<br />
    {:else if node.type === "thematicBreak"}<hr />
    {:else if node.type === "link"}
      {#if link(node.url)}<a href={link(node.url)} rel="noreferrer"
          >{@render nodes(node.children)}</a
        >{:else}{@render nodes(node.children)}{/if}
    {:else if node.type === "image"}
      {#if image(node.url)}<img src={image(node.url)} alt={node.alt ?? ""} />{:else}<span
          >{node.alt ?? "External image omitted"}</span
        >{/if}
    {:else if node.type === "html"}{node.value}
    {:else if node.type === "linkReference"}
      {@const destination = definitions.get(normalizeIdentifier(node.identifier)) ?? ""}
      {#if link(destination)}<a href={link(destination)} rel="noreferrer"
          >{@render nodes(node.children)}</a
        >{:else}{@render nodes(node.children)}{/if}
    {:else if node.type === "imageReference"}
      {@const destination = definitions.get(normalizeIdentifier(node.identifier)) ?? ""}
      {#if image(destination)}<img
          src={image(destination)}
          alt={node.alt ?? ""}
        />{:else}{node.alt ?? ""}{/if}
    {/if}
  {/each}
{/snippet}
<section class="preview" aria-label="Markdown preview">{@render nodes(tree.children)}</section>

<style>
  .preview {
    overflow-wrap: anywhere;
    max-inline-size: 75ch;
  }
  .preview :global(p),
  .preview :global(pre),
  .preview :global(blockquote),
  .preview :global(ul),
  .preview :global(ol) {
    margin-block: 1rem;
  }
  .preview {
    line-height: 1.75;
  }
  .preview > :global(:first-child) {
    margin-block-start: 0;
  }
  .preview :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin-block: 1.5em 0.625em;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.02em;
  }
  .preview :global(h1) {
    font-size: 1.75rem;
  }
  .preview :global(h2) {
    font-size: 1.375rem;
  }
  .preview :global(h3) {
    font-size: 1.125rem;
  }
  .preview :global(ul) {
    list-style: disc;
    padding-inline-start: 1.5rem;
  }
  .preview :global(ol) {
    list-style: decimal;
    padding-inline-start: 1.5rem;
  }
  .preview :global(li + li) {
    margin-block-start: 0.375rem;
  }
  .preview :global(blockquote) {
    border-inline-start: 1px solid var(--rule-strong);
    padding-inline-start: 1rem;
    color: var(--muted);
  }
  .preview :global(code) {
    font-family: ui-monospace, monospace;
    font-size: 0.875em;
    background: var(--surface);
    border-radius: 0.25rem;
    padding: 0.125em 0.25em;
  }
  .preview :global(pre) {
    background: var(--surface);
    padding: 1rem;
    border-radius: var(--radius);
  }
  .preview :global(hr) {
    border: 0;
    border-block-start: 1px solid var(--rule);
    margin-block: 1.5rem;
  }
  .preview :global(img) {
    max-inline-size: 100%;
    block-size: auto;
  }
  .preview :global(a) {
    text-decoration: underline;
  }
  .preview :global(pre) {
    white-space: pre-wrap;
  }
</style>
