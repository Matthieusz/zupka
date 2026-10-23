<script lang="ts">
  import { Dialog } from "bits-ui";
</script>

<Dialog.Root>
  <Dialog.Trigger
    class="w-fit rounded-lg bg-lime-400 px-4 py-2 font-medium text-zinc-950 transition hover:bg-lime-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lime-400"
  >
    Open example dialog
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 bg-black/70" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 w-[calc(100%-3rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-xl"
    >
      <Dialog.Title class="text-xl font-semibold">Everything starts here</Dialog.Title>
      <Dialog.Description class="mt-3 text-zinc-400">
        An accessible Bits UI dialog, styled with Tailwind CSS.
      </Dialog.Description>
      <Dialog.Close
        class="mt-6 rounded-lg bg-zinc-100 px-4 py-2 font-medium text-zinc-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lime-400"
      >
        Close
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
