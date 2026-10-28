import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { ConfigProvider, Effect, Layer, Predicate, Redacted, Schema } from "effect";
import { HashingLive, OwnerCommandError, setOwnerPassword } from "./auth.js";
import { StorageLive } from "./storage.js";

// Never accept credentials through process arguments, environment variables, or redirected input.
async function main() {
  process.umask(0o077);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Owner commands require an interactive terminal.");
  }

  if (process.argv.length !== 3) {
    throw new Error(
      "Owner commands accept only create or recover; passwords must be entered at the prompt.",
    );
  }

  const mode = Schema.decodeUnknownSync(Schema.Literals(["create", "recover"]))(process.argv[2]);
  let hidden = false;

  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk);
      done();
    },
  });

  const terminal = createInterface({ input: process.stdin, output, terminal: true });

  try {
    const email = await terminal.question("Owner email: ");
    process.stdout.write("Password (12–1024 characters): ");
    hidden = true;
    const password = Redacted.make(await terminal.question(""));
    process.stdout.write("\nConfirm password: ");
    const confirmation = Redacted.make(await terminal.question(""));
    process.stdout.write("\n");

    if (Redacted.value(password) !== Redacted.value(confirmation)) {
      throw new Error("Passwords do not match.");
    }

    const result = await Effect.runPromise(
      setOwnerPassword(mode, email, password).pipe(
        Effect.provide(
          Layer.merge(HashingLive, StorageLive).pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
            ),
          ),
        ),
        Effect.result,
      ),
    );

    if (Predicate.isTagged(result, "Failure")) {
      const message = Schema.is(OwnerCommandError)(result.failure)
        ? result.failure.message
        : "Owner operation failed. Check database access and configuration.";

      process.stderr.write(`${message}\n`);
      process.exitCode = 1;

      return;
    }

    process.stdout.write(
      mode === "create"
        ? "Owner created. You can now sign in.\n"
        : "Password replaced. Previous sessions are invalid.\n",
    );
  } finally {
    hidden = false;
    terminal.close();
    output.destroy();
  }
}

await main().catch(() => {
  process.stderr.write(
    "Owner command failed. Use an interactive terminal and matching passwords.\n",
  );
  process.exitCode = 1;
});
