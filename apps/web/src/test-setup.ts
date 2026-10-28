import { cleanup } from "@testing-library/svelte";
import { afterEach } from "vite-plus/test";

// jsdom has no layout or scrolling; Bits UI command keyboard navigation uses this browser API.
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value() {},
});

afterEach(cleanup);
