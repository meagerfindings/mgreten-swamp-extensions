import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { renderMarketingCalendar } from "./marketing_content_calendar.ts";

Deno.test("renders a neutral calendar for configurable channels and states", async () => {
  const calendar = {
    schemaVersion: "1.0",
    generatedAt: "2026-08-28T13:00:00Z",
    from: null,
    until: null,
    entries: [{
      schemaVersion: "1.0",
      campaignId: "campaign-1",
      releaseId: "release-1",
      itemId: "item-1",
      ideaId: "idea-1",
      variantId: "variant-1",
      label: "Launch note",
      channel: "newsletter",
      scheduledAt: "2026-09-01T15:00:00Z",
      timeZone: "UTC",
      status: "published",
      approvalState: "approved",
      intendedPlatformState: "send",
      observedPlatformState: "delivered",
      successfulObservedStates: ["delivered"],
      releaseDigest: "a".repeat(64),
      dispatchAttemptId: "attempt-1",
      dispatchClaimId: "b".repeat(64),
      platformReference: "delivery-42",
      detail: null,
      updatedAt: "2026-09-01T15:00:01Z",
    }],
  };
  const result = await renderMarketingCalendar({
    modelType: "@mgreten/marketing-orchestration",
    modelId: "model-1",
    methodName: "calendar",
    dataHandles: [{
      kind: "resource",
      specName: "calendar",
      name: "calendar-current",
      version: 1,
    }],
    dataRepository: {
      getContent: () =>
        Promise.resolve(new TextEncoder().encode(JSON.stringify(calendar))),
    },
  });
  assertStringIncludes(result.markdown, "# Marketing Content Calendar");
  assertStringIncludes(result.markdown, "newsletter");
  assertStringIncludes(result.markdown, "published=1");
  assertEquals((result.json.calendar as typeof calendar).entries.length, 1);
});

Deno.test("ignores unrelated methods", async () => {
  assertEquals(
    await renderMarketingCalendar({
      modelType: "@mgreten/marketing-orchestration",
      modelId: "model-1",
      methodName: "captureIdeation",
      dataHandles: [],
      dataRepository: { getContent: () => Promise.resolve(null) },
    }),
    { markdown: "", json: {} },
  );
});

Deno.test("reports contextual snapshot errors", async () => {
  await assertRejects(
    () =>
      renderMarketingCalendar({
        modelType: "@mgreten/marketing-orchestration",
        modelId: "model-1",
        methodName: "calendar",
        dataHandles: [{
          kind: "resource",
          specName: "calendar",
          name: "calendar-current",
          version: 7,
        }],
        dataRepository: {
          getContent: () =>
            Promise.resolve(new TextEncoder().encode("not-json")),
        },
      }),
    Error,
    "calendar-current version 7 contains invalid JSON",
  );
});
