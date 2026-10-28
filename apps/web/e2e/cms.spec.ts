import { expect, test } from "@playwright/test";
import { AdminEntry, EntryPage, ManagedImage, PublicEntry } from "@zupka/contracts";
import { Schema } from "effect";

const email = "owner@example.invalid";

const password = "disposable owner password";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// One serial owner workflow uses only the disposable configured checkout/volume.
// No route interception, synthetic cookie injection, storage seeding or mocked HTTP.
test("v1 owner and visitor workflow through HTTPS, the proxy and the packaged service", async ({
  page,
  context,
  browser,
  baseURL,
}, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const headers = { Origin: baseURL ?? "", "x-effect-auth-csrf": "1" };
  const guest = await browser.newContext({ ignoreHTTPSErrors: true });
  const acceptDialog = (dialog: import("@playwright/test").Dialog) => dialog.accept();
  page.on("dialog", acceptDialog);

  async function screenshot(name: string) {
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  }

  async function login() {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }

  async function include(label: string) {
    await page.getByRole("button", { name: `Add ${label}`, exact: true }).click();
  }

  async function title(value: string) {
    await page.getByRole("textbox", { name: "Title", exact: true }).fill(value);
    await page.getByRole("textbox", { name: "Slug", exact: true }).focus();
  }

  async function command(name: string, feedback: string) {
    const button = page.getByRole("button", { name, exact: true });

    if (name === "Save draft") await button.press("Enter");
    else await button.click();
    await expect(page.locator("#editor-announcement")).toContainText(feedback);
    await expect(page.locator("#editor-announcement")).toHaveClass("sr-only");
    await expect(page.locator("#editor-announcement")).not.toBeFocused();
    await expect(page.locator("#editor-feedback")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
  }

  async function navigate(type: string) {
    await page.getByRole("link", { name: type, exact: true }).click();
    await expect(page.getByRole("heading", { name: type, exact: true, level: 1 })).toBeVisible();
  }

  try {
    await test.step("real login, keyboard focus, Secure cookie and session restart", async () => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Owner sign in" })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
      await screenshot("desktop-login-keyboard");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill("wrong password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Sign in failed");
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
      await screenshot("desktop-login-error");
      const admitted = page.waitForRequest((request) => request.url().endsWith("/api/auth/signIn"));
      await login();
      expect(await (await admitted).allHeaders()).toMatchObject({
        origin: baseURL,
        "x-effect-auth-csrf": "1",
      });
      await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "No entries yet" })).toBeVisible();
      const cookies = await context.cookies();
      const session = cookies.find((cookie) => cookie.name.startsWith("__Host-"));
      expect(session).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
        domain: "localhost",
        path: "/",
      });
      expect(await page.evaluate(() => document.cookie)).not.toContain(session?.name);
      await page.reload();
      await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
      await screenshot("desktop-empty-list");
    });

    await test.step("anonymous/CSRF/origin admission remains enforced through the proxy", async () => {
      expect(
        (
          await guest.request.post(`${baseURL}/api/admin/entries/posts`, {
            data: { title: "Anonymous" },
            headers,
          })
        ).status(),
      ).toBe(401);
      expect((await guest.request.get(`${baseURL}/api/admin/content-types`)).status()).toBe(401);
      expect(
        (await page.request.get("/api/not-a-route", { headers: { Accept: "text/html" } })).status(),
      ).toBe(404);

      // Browser supplies the real Origin and existing HttpOnly cookie; omitting CSRF still fails.
      const noCsrf = await page.evaluate(
        async () =>
          (
            await fetch("/api/admin/entries/posts", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: "Denied" }),
            })
          ).status,
      );

      expect(noCsrf).toBe(403);
      expect(
        (
          await page.request.post("/api/admin/entries/posts", {
            data: { title: "Denied" },
            headers: { ...headers, Origin: "https://foreign.invalid" },
          })
        ).status(),
      ).toBe(403);
    });

    let image: typeof ManagedImage.Type;
    let post: typeof AdminEntry.Type;
    let published: typeof PublicEntry.Type;

    const postTitle =
      "A deliberately long title about independent publishing, private drafts and a smaller web that remains readable on narrow screens";

    await test.step("Post: all built-in fields, upload, managed Markdown and XSS-safe preview", async () => {
      await page.getByRole("button", { name: "New entry" }).click();
      await expect(page.locator("#editor-heading")).toBeFocused();
      await title(postTitle);
      await expect(page.getByRole("textbox", { name: "Slug", exact: true })).not.toHaveValue("");
      await page.getByRole("textbox", { name: "Slug", exact: true }).fill("browser-post");
      await include("Summary");
      await page
        .getByRole("textbox", { name: "Summary", exact: true })
        .fill("Private until publication.");
      await include("Body");
      await page
        .getByRole("textbox", { name: "Body", exact: true })
        .fill(
          '# A considered draft\n\n<script>window.previewExecuted=true</script>\n\n<img src=x onerror="window.previewExecuted=true">\n\n[Unsafe](javascript:alert%281%29)',
        );
      await include("Publication date");
      await page
        .getByRole("textbox", { name: "Publication date", exact: true })
        .fill("2026-07-20T12:00:00+02:00");
      await include("Tags");
      await page.getByRole("button", { name: "Add Tags item" }).click();
      await page.getByRole("textbox", { name: "Tags item 1" }).fill("a multiline\nitem");
      await page.getByRole("button", { name: "Add Tags item" }).click();
      await include("Cover image");
      await page.getByRole("button", { name: "Choose Cover image" }).click();
      await expect(page.locator("#image-picker-title")).toBeFocused();
      await page.getByRole("button", { name: "Upload", exact: true }).click();
      await page.getByLabel("Image file").setInputFiles({
        name: "forged.png",
        mimeType: "image/png",
        buffer: Buffer.from("not a real image"),
      });
      await page.getByRole("button", { name: "Upload image" }).click();
      await expect(page.getByRole("dialog").getByRole("alert")).toContainText("valid JPEG");
      await page
        .getByLabel("Image file")
        .setInputFiles({ name: "verified.png", mimeType: "image/png", buffer: png });

      const uploaded = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/admin/images") && response.request().method() === "POST",
      );

      await page.getByRole("button", { name: "Upload image" }).click();
      image = Schema.decodeUnknownSync(ManagedImage)(await (await uploaded).json());
      await expect(
        page.getByRole("dialog").getByRole("status").filter({ hasText: "Uploaded" }),
      ).toBeVisible();
      expect((await guest.request.get(`${baseURL}${image.url}`)).status()).toBe(401);
      await page
        .getByRole("textbox", { name: "Alt text for selected image" })
        .fill("A synthetic verification pixel");
      await page.getByRole("button", { name: "Choose image", exact: true }).click();
      await expect(page.locator("#field-cover-image")).toBeFocused();
      await page.getByRole("button", { name: "Insert managed image" }).click();
      await page.getByRole("button", { name: /Select image 1/ }).click();
      await page
        .getByRole("textbox", { name: "Alt text for selected image" })
        .fill("Managed Markdown image");
      await page.getByRole("button", { name: "Insert image", exact: true }).click();
      await page.getByRole("button", { name: "Preview Markdown" }).click();
      await expect
        .poll(() =>
          page.locator(".preview img").evaluate((img: HTMLImageElement) => img.naturalWidth),
        )
        .toBe(1);
      expect(await page.evaluate(() => Reflect.has(window, "previewExecuted"))).toBe(false);
      await expect(
        page.locator('.preview script, .preview [onerror], .preview a[href^="javascript:"]'),
      ).toHaveCount(0);
      await screenshot("desktop-post-preview");
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot("narrow-post-preview");

      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/admin/entries/posts") &&
          response.request().method() === "POST",
      );

      await command("Save draft", "Draft saved");
      post = Schema.decodeUnknownSync(AdminEntry)(await (await created).json());
      expect(post.draft.fields.tags).toEqual(["a multiline\nitem", ""]);
      expect((await guest.request.get(`${baseURL}/api/content/posts/browser-post`)).status()).toBe(
        404,
      );
      await command("Publish", "Published.");
      published = Schema.decodeUnknownSync(PublicEntry)(
        await (await guest.request.get(`${baseURL}/api/content/posts/browser-post`)).json(),
      );
      expect(published.fields["cover-image"]).toEqual({
        url: image.url,
        alt: "A synthetic verification pixel",
      });
      expect((await guest.request.get(`${baseURL}${image.url}`)).status()).toBe(200);
      await expect(page.getByRole("textbox", { name: "Slug", exact: true })).toHaveAttribute(
        "readonly",
        "",
      );
      await expect(page.getByRole("button", { name: "Delete entry" })).toBeDisabled();
      await page.getByRole("button", { name: "Back to Posts" }).click();
      await expect(page.getByRole("button", { name: postTitle, exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1440, height: 900 });
      await screenshot("desktop-long-title-list");
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot("narrow-long-title-list");
      await page.getByRole("button", { name: postTitle, exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#editor-heading")).toBeFocused();
      await title("A revised title, not yet public");
      await command("Save draft", "Draft saved");
      expect(
        Schema.decodeUnknownSync(PublicEntry)(
          await (await guest.request.get(`${baseURL}/api/content/posts/browser-post`)).json(),
        ),
      ).toEqual(published);
      await screenshot("narrow-saved-draft-changes");
    });

    await test.step("server validation, conflicting deletion and concurrent writer", async () => {
      const path = `/api/admin/entries/posts/${post.id}`;

      const current = Schema.decodeUnknownSync(AdminEntry)(
        await (await page.request.get(path)).json(),
      );

      expect(
        (
          await page.request.post("/api/admin/entries/posts", {
            headers,
            data: { title: "Duplicate", slug: "browser-post" },
          })
        ).status(),
      ).toBe(409);
      expect(
        (
          await page.request.put(path, {
            headers,
            data: { revision: current.revision, content: { ...current.draft, slug: "changed" } },
          })
        ).status(),
      ).toBe(409);
      expect(
        (
          await page.request.put(path, {
            headers,
            data: {
              revision: current.revision,
              content: { ...current.draft, fields: { tags: 123 } },
            },
          })
        ).status(),
      ).toBe(400);
      expect(
        (
          await page.request.delete(path, { headers, data: { revision: current.revision } })
        ).status(),
      ).toBe(409);
      expect(
        (await page.request.delete(`/api/admin/images/${image.id}`, { headers })).status(),
      ).toBe(409);
      expect(
        (
          await page.request.put(path, {
            headers,
            data: {
              revision: current.revision,
              content: { ...current.draft, title: "Separate writer" },
            },
          })
        ).status(),
      ).toBe(200);
      await title("Local work that must survive conflict");
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await expect(page.locator("#editor-feedback")).toContainText("changed elsewhere");
      await page.getByRole("button", { name: "Load latest saved version" }).click();
      await expect(
        page
          .locator(".latest-version")
          .getByRole("heading", { name: "Separate writer", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".entry-title textarea")).toHaveValue(
        "Local work that must survive conflict",
      );
      await screenshot("narrow-stale-conflict");
      await page.getByRole("button", { name: "Discard local input and use latest" }).click();
      await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
        "Separate writer",
      );
    });

    await test.step("network/session failure retains input, re-authentication and guarded deletion", async () => {
      await title("Retained across network and session failure");
      await page.getByRole("button", { name: /^Versions/ }).click();
      await context.setOffline(true);
      await page.getByRole("button", { name: "Load latest saved version" }).click();
      await expect(page.locator("#editor-feedback")).toContainText("could not be confirmed");
      await screenshot("narrow-network-error");
      await context.setOffline(false);
      await page.evaluate(async () => {
        await fetch("/api/auth/signOut", {
          method: "POST",
          headers: { "content-type": "application/json", "x-effect-auth-csrf": "1" },
          body: JSON.stringify({ payload: {} }),
        });
      });
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Owner sign in" })).toBeVisible();
      await screenshot("narrow-session-ended");
      await login();
      await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
        "Retained across network and session failure",
      );
      await command("Save draft", "Draft saved");
      await command("Publish", "Published.");
      await command("Unpublish", "Unpublished.");
      expect((await guest.request.get(`${baseURL}/api/content/posts/browser-post`)).status()).toBe(
        404,
      );
      expect(
        (
          await guest.request.head(`${baseURL}${image.url}`, { headers: { "If-None-Match": "*" } })
        ).status(),
      ).toBe(401);
      await page.getByRole("button", { name: "Back to Posts" }).click();
      await navigate("Images");
      await page.getByRole("button", { name: "Delete image" }).click();
      await expect(page.locator(".library [role=alert]")).toContainText(
        "referenced by a saved draft",
      );
      await screenshot("narrow-image-reference-error");
      await navigate("Posts");
      await page
        .getByRole("button", { name: "Retained across network and session failure", exact: true })
        .click();
      await page.getByRole("button", { name: "Delete entry" }).click();
      await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
      await navigate("Images");
      await page.getByRole("button", { name: "Delete image" }).click();
      await expect(
        page.locator(".library [role=status]").filter({ hasText: "permanently deleted" }),
      ).toBeVisible();
    });

    await test.step("Project URLs/lists, unsaved-navigation confirmation and full lifecycle", async () => {
      await navigate("Projects");
      await page.getByRole("button", { name: "New entry" }).click();
      await title("Independent portfolio");
      await include("Technologies");
      await page.getByRole("button", { name: "Add Technologies item" }).click();
      await page.getByRole("textbox", { name: "Technologies item 1" }).fill("Svelte and Effect");
      await include("Live site");
      await page
        .getByRole("textbox", { name: "Live site", exact: true })
        .fill("javascript:alert(1)");
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await expect(page.locator("#error-live-site")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Live site", exact: true })).toHaveValue(
        "javascript:alert(1)",
      );
      await screenshot("narrow-field-validation");
      await page
        .getByRole("textbox", { name: "Live site", exact: true })
        .fill("https://example.com");
      await include("Repository");
      await page
        .getByRole("textbox", { name: "Repository", exact: true })
        .fill("https://example.com/source");
      await command("Save draft", "Draft saved");
      await command("Publish", "Published.");
      expect(
        (await guest.request.get(`${baseURL}/api/content/projects/independent-portfolio`)).status(),
      ).toBe(200);
      await command("Unpublish", "Unpublished.");
      await title("Unsaved navigation check");
      page.off("dialog", acceptDialog);
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("button", { name: "Back to Projects" }).click();
      await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
        "Unsaved navigation check",
      );
      page.on("dialog", acceptDialog);
      await title("Independent portfolio");
      await command("Save draft", "Draft saved");
      await page.getByRole("button", { name: "Delete entry" }).click();
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    });

    await test.step("custom type: defaults, required publication validation, number/boolean/select", async () => {
      await navigate("Talks");
      await page.getByRole("button", { name: "New entry" }).click();
      await title("Deep modules in practice");
      await expect(page.locator("#field-duration")).toHaveValue("30");
      await expect(page.locator("#field-recorded")).toHaveValue("false");
      await command("Save draft", "Draft saved");
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.locator("#error-venue")).toContainText("Required for publication");
      await include("Venue");
      await page.locator("#field-venue").fill("Community hall");
      await page.locator("#field-duration").fill("45");
      await page.locator("#field-recorded").selectOption("true");
      await page.locator("#field-format").selectOption("Conference");
      await command("Save draft", "Draft saved");
      await command("Publish", "Published.");

      const talk = Schema.decodeUnknownSync(PublicEntry)(
        await (
          await guest.request.get(`${baseURL}/api/content/talks/deep-modules-in-practice`)
        ).json(),
      );

      expect(talk.fields).toMatchObject({
        venue: "Community hall",
        duration: 45,
        recorded: true,
        format: "Conference",
      });
      await screenshot("narrow-custom-type");
      await page.setViewportSize({ width: 1440, height: 900 });
      await screenshot("desktop-custom-type");
      await command("Unpublish", "Unpublished.");
      await page.getByRole("button", { name: "Delete entry" }).click();
      await expect(page.getByRole("heading", { name: "Talks", exact: true })).toBeVisible();
    });

    await test.step("hash navigation reload, search/filter recovery and logout", async () => {
      await navigate("Posts");
      await page.reload();
      await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
      await page.getByRole("searchbox", { name: "Title search" }).fill("not found");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No matching entries" })).toBeVisible();
      await page.getByRole("combobox", { name: "Publication state" }).selectOption("published");
      await page.getByRole("button", { name: "Clear filters", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No entries yet" })).toBeVisible();

      const remaining = Schema.decodeUnknownSync(EntryPage)(
        await (await page.request.get("/api/admin/entries/posts")).json(),
      );

      expect(remaining.total).toBe(0);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Owner sign in" })).toBeVisible();
      expect((await page.request.get("/api/admin/content-types")).status()).toBe(401);
      expect(pageErrors).toEqual([]);
    });
  } finally {
    await guest.close();
  }
});
