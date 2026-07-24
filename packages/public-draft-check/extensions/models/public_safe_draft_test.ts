import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.11";
import { model } from "./public_safe_draft.ts";

type StoredDraft = {
  publicDraft: string;
  redactions: Array<{ category: string; count: number }>;
  manualReview: string[];
};

Deno.test("draft redacts known sensitive values and preserves the lesson", async () => {
  let stored: StoredDraft | undefined;
  const result = await model.methods.draft.execute(
    {
      title: "Safe reflection",
      thesis: "A clear thesis can survive operational detail redaction.",
      journey:
        "A token API_TOKEN=demo-secret appeared at https://private.tailnet.ts.net/api/ in /srv/private/note.md.",
      lesson:
        "Preserve the repair sequence and explicitly name the reusable practice.",
      sensitiveTerms: ["private.tailnet.ts.net", "demo-secret"],
    },
    {
      globalArgs: { redactionLabel: "[redacted]" },
      logger: { info: () => undefined },
      writeResource: (_specName, _instanceName, data) => {
        stored = data;
        return Promise.resolve({ id: "test-handle" });
      },
    },
  );

  assertEquals(result.dataHandles.length, 1);
  assert(stored);
  assertStringIncludes(stored.publicDraft, "[redacted]");
  assert(!stored.publicDraft.includes("demo-secret"));
  assert(!stored.publicDraft.includes("private.tailnet.ts.net"));
  assert(!stored.publicDraft.includes("/srv/private/note.md"));
  assertStringIncludes(stored.publicDraft, "Preserve the repair sequence");
  assert(stored.redactions.length >= 2);
  assertEquals(stored.manualReview.length, 3);
});
