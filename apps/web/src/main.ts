import { mount } from "svelte";
import Root from "./Root.svelte";
import "./app.css";

const target = document.getElementById("app");

if (!target) {
  throw new Error("Missing #app mount target");
}

mount(Root, { target });
