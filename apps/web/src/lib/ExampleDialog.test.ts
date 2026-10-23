import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vite-plus/test";
import ExampleDialog from "./ExampleDialog.svelte";

it("opens and closes the Bits UI dialog", async () => {
  const user = userEvent.setup();

  render(ExampleDialog);
  await user.click(screen.getByRole("button", { name: "Open example dialog" }));

  expect(screen.getByRole("dialog")).toBeDefined();
  expect(screen.getByRole("heading", { name: "Everything starts here" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Close" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
