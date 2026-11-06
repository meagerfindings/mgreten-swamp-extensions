import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./dev_server.ts";

Deno.test("model persists status resources without command-output files", () => {
  assertEquals("files" in model, false);
  assertEquals(
    model.methods.start.arguments.safeParse({ extra: true }).success,
    false,
  );
  assertEquals(
    model.methods.stop.arguments.safeParse({ extra: true }).success,
    false,
  );
  assertEquals(
    model.methods.status.arguments.safeParse({ extra: true }).success,
    false,
  );
});
