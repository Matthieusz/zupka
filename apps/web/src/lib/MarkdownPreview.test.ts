import { render, screen } from "@testing-library/svelte";
import { expect, it } from "vite-plus/test";
import MarkdownPreview from "./MarkdownPreview.svelte";

it("resolves reference-style links and managed images with the same URL safety policy", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  render(MarkdownPreview, {
    source: `[Good][site] [Bad][unsafe] ![Private][photo]\n\n[site]: https://example.com\n[unsafe]: javascript:alert%281%29\n[photo]: /api/images/${id}`,
  });
  expect(screen.getByRole("link", { name: "Good" }).getAttribute("href")).toBe(
    "https://example.com",
  );
  expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
  expect(screen.getByRole("img", { name: "Private" }).getAttribute("src")).toBe(
    `/api/images/${id}`,
  );
});

it("renders CommonMark without executing HTML, MDX, executable links or external image requests", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  const { container } = render(MarkdownPreview, {
    source: `# Preview\n\n**Strong** and *emphasis*\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert%281%29) [safe](https://example.com)\n\n![private](/api/images/${id}) ![remote](https://tracker.invalid/pixel)\n\n<Component />\n\n\`<script>code</script>\``,
  });

  expect(screen.getByRole("heading", { name: "Preview" })).toBeDefined();
  expect(container.querySelector("strong")?.textContent).toBe("Strong");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("[onerror]")).toBeNull();
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "safe" }).getAttribute("href")).toBe(
    "https://example.com",
  );
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(screen.getByRole("img", { name: "private" }).getAttribute("src")).toBe(
    `/api/images/${id}`,
  );
  expect(container.textContent).toContain("<script>alert(1)</script>");
  expect(container.textContent).toContain("<Component />");
});
