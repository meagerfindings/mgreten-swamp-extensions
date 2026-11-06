import { assert, assertEquals } from "jsr:@std/assert@1.0.11";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260604.20";
import { checkDraft, model } from "./public_draft_check.ts";

Deno.test("check reports blockers without echoing matched values", () => {
  const sentinel = "Project Nightjar";
  const draft = [
    "A reflection about Project Nightjar.",
    "API_TOKEN=demo-secret",
    "The service was at printer.office.local and 192.168.2.4.",
  ].join("\n");
  const report = checkDraft({ draft, sensitiveTerms: [sentinel] });

  assertEquals(report.status, "blocked");
  assertEquals(report.blockingRuleCount, 4);
  assertEquals(report.reviewRuleCount, 0);
  assertEquals(
    report.findings.map((item) => item.rule),
    [
      "caller-supplied-sensitive-term",
      "credential-like-value",
      "private-hostname",
      "private-ip-address",
    ],
  );
  assertEquals(report.findings[0].locations, [{ line: 1, column: 20 }]);
  assert(!JSON.stringify(report).includes(sentinel));
  assert(!JSON.stringify(report).includes("demo-secret"));
});

Deno.test("check distinguishes review findings from blockers", () => {
  const report = checkDraft({
    draft:
      "Contact editor@example.com about /Users/alice/private.md and 9f1c2a6e-6aba-4b25-9952-d227e79a0c95.",
    sensitiveTerms: [],
  });

  assertEquals(report.status, "review_required");
  assertEquals(report.blockingRuleCount, 0);
  assertEquals(report.reviewRuleCount, 3);
  assertEquals(
    report.findings.map((item) => item.rule),
    ["absolute-filesystem-path", "email-address", "uuid"],
  );
});

Deno.test("check preserves public URLs and ignores invalid private-looking IPs", () => {
  const report = checkDraft({
    draft: "Read https://example.com/etc/passwd from 10.999.999.999.",
    sensitiveTerms: [],
  });

  assertEquals(report.status, "clear");
  assertEquals(report.findings, []);
  assertEquals(report.manualReviewRequired, true);
});

Deno.test("check detects file URLs and does not block empty credentials or ambiguous prose", () => {
  const report = checkDraft({
    draft:
      'The secret: success. password="". Inspect file:///etc/passwd before publishing.',
    sensitiveTerms: [],
  });

  assertEquals(report.status, "review_required");
  assertEquals(report.blockingRuleCount, 0);
  assertEquals(report.findings.map((item) => item.rule), [
    "absolute-filesystem-path",
  ]);
});

Deno.test("check merges overlapping credential matches", () => {
  const report = checkDraft({
    draft: "Authorization: Bearer eyJheader.payload.signature",
    sensitiveTerms: [],
  });

  assertEquals(report.status, "blocked");
  assertEquals(report.findings[0].rule, "credential-like-value");
  assertEquals(report.findings[0].count, 1);
  assertEquals(report.findings[0].locations.length, 1);
});

Deno.test("check reports Unicode-aware multiline locations", () => {
  const report = checkDraft({
    draft: "Public line 😀\nPrivate Project Nightjar detail",
    sensitiveTerms: ["Project Nightjar"],
  });

  assertEquals(report.findings[0].locations, [{ line: 2, column: 9 }]);
});

Deno.test("check caps reported locations without losing occurrence count", () => {
  const report = checkDraft({
    draft: Array.from({ length: 75 }, () => "private-term").join(" "),
    sensitiveTerms: ["private-term"],
  });

  assertEquals(report.findings[0].count, 75);
  assertEquals(report.findings[0].locations.length, 50);
  assertEquals(report.findings[0].locationsTruncated, true);
});

Deno.test("model writes a report and logs no candidate text", async () => {
  const sentinel = "never-log-this";
  const { context, getLogs, getWrittenResources } = createModelTestContext({
    methodName: "check",
    globalArgs: {},
  });

  const result = await model.methods.check.execute(
    { draft: `Draft containing ${sentinel}.`, sensitiveTerms: [sentinel] },
    context,
  );

  assertEquals(result.dataHandles?.length, 1);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "report");
  assertEquals(written[0].name, "current");
  assertEquals(written[0].data.status, "blocked");
  assertEquals(
    model.resources.report.schema.safeParse(written[0].data).success,
    true,
  );
  assert(!JSON.stringify(written[0].data).includes(sentinel));
  assert(!JSON.stringify(getLogs()).includes(sentinel));
});
