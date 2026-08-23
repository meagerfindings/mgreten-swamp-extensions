import {
  buildOperationalDigest,
  DIGEST_SECTIONS,
  model,
} from "./operational_digest.ts";
import { syntheticSourceV1 } from "./fixtures/v1.ts";

const assert = (value: unknown, message = "assertion failed") => {
  if (!value) throw new Error(message);
};
const equal = (left: unknown, right: unknown) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${JSON.stringify(left)} != ${JSON.stringify(right)}`);
  }
};
const rejects = (input: unknown, expected: string) => {
  try {
    buildOperationalDigest(input);
  } catch (error) {
    assert(String(error).includes(expected), String(error));
    return;
  }
  throw new Error(`expected ${expected}`);
};
const input = () => ({
  digestId: "daily-2026-08-23",
  generatedAt: "2026-08-23T12:00:00Z",
  sections: DIGEST_SECTIONS.map((section, index) =>
    index === 4
      ? {
        section,
        availability: "missing" as const,
        missingReason: "No normalized fresh evidence is available.",
        sourceReferences: [],
        items: [],
      }
      : {
        section,
        availability: "available" as const,
        missingReason: null,
        sourceReferences: [syntheticSourceV1(`source-${index}`)],
        items: [
          {
            itemId: `low-${index}`,
            dedupeKey: `duplicate-${index}`,
            severity: "low" as const,
            observedAt: "2026-08-23T10:00:00Z",
            summary: "Synthetic normalized observation",
            recommendation: "Review the cited evidence.",
            sourceIds: [`source-${index}`],
          },
          {
            itemId: `critical-${index}`,
            dedupeKey: `duplicate-${index}`,
            severity: "critical" as const,
            observedAt: "2026-08-23T11:00:00Z",
            summary: "Synthetic higher-severity observation",
            recommendation: "Prioritize review of the cited evidence.",
            sourceIds: [`source-${index}`],
          },
        ],
      }
  ),
});

Deno.test("v1 fixture is deterministic, complete, cited, ordered, and redacted", () => {
  const first = buildOperationalDigest(input());
  const second = buildOperationalDigest({
    ...input(),
    sections: [...input().sections].reverse(),
  });
  equal(first, second);
  equal(first.sections.map((section) => section.section), DIGEST_SECTIONS);
  equal(first.sections[0].items.map((item) => item.itemId), ["critical-0"]);
  equal(first.sections[4].availability, "missing");
  equal(first.truncated, false);
  equal(first.authority, {
    mode: "recommendation-only",
    sideEffects: "none",
    agentInvocation: "none",
  });
});

Deno.test("per-section cap reports omitted sorted items", () => {
  const capped = input();
  const section = capped.sections[0];
  if (section.availability !== "available") throw new Error("fixture error");
  section.items = Array.from({ length: 6 }, (_, index) => ({
    itemId: `item-${index}`,
    dedupeKey: `unique-${index}`,
    severity: index === 5 ? "critical" as const : "low" as const,
    observedAt: `2026-08-23T0${index + 1}:00:00Z`,
    summary: "Synthetic normalized observation",
    recommendation: "Review the cited evidence.",
    sourceIds: ["source-0"],
  }));
  const result = buildOperationalDigest(capped);
  equal(result.sections[0].items.length, 5);
  equal(result.sections[0].items[0].itemId, "item-5");
  equal(result.truncated, true);
});

Deno.test("global cap reports items omitted after per-section sorting", () => {
  const capped = input();
  capped.sections.forEach((section, sectionIndex) => {
    if (section.availability !== "available") return;
    section.items = Array.from({ length: 5 }, (_, itemIndex) => ({
      itemId: `item-${sectionIndex}-${itemIndex}`,
      dedupeKey: `unique-${sectionIndex}-${itemIndex}`,
      severity: "low" as const,
      observedAt: `2026-08-23T0${itemIndex + 1}:00:00Z`,
      summary: "Synthetic normalized observation",
      recommendation: "Review the cited evidence.",
      sourceIds: [`source-${sectionIndex}`],
    }));
  });
  const result = buildOperationalDigest(capped);
  assert(
    result.sections.reduce((sum, section) => sum + section.items.length, 0) <=
      24,
  );
  equal(result.truncated, true);
});

Deno.test("v1 fixture fails closed for stale, future, uncited, and non-redacted evidence", () => {
  const stale = input();
  if (stale.sections[0].availability === "available") {
    stale.sections[0].sourceReferences[0].freshness.expiresAt =
      "2026-08-23T11:59:59Z";
  }
  rejects(stale, "stale at generatedAt");
  const uncited = input();
  if (uncited.sections[0].availability === "available") {
    uncited.sections[0].items[0].sourceIds = ["unknown"];
  }
  rejects(uncited, "unavailable section source");
  const future = input();
  if (future.sections[0].availability === "available") {
    future.sections[0].items[0].observedAt = "2026-08-23T12:00:01Z";
  }
  rejects(future, "future item");
  const unredacted = input();
  if (unredacted.sections[0].availability === "available") {
    (unredacted.sections[0].sourceReferences[0] as { redacted: boolean })
      .redacted = false;
  }
  rejects(unredacted, "redacted");
});

Deno.test("model writes one digest and exposes no effectful collaborators", async () => {
  const writes: unknown[] = [];
  const result = await model.methods.build.execute(input(), {
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: "daily" });
    },
  });
  equal(writes.length, 1);
  equal(result, { dataHandles: [{ name: "daily" }] });
  equal(Object.keys(model.methods), ["build"]);
  assert(!("files" in model));
});

Deno.test("limits measure the complete persisted canonical output", () => {
  const digest = buildOperationalDigest(input());
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
      ? `{${
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b)
        ).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
          .join(",")
      }}`
      : JSON.stringify(value);
  const persisted = canonical(digest);
  equal(digest.limits.bytes, new TextEncoder().encode(persisted).byteLength);
  equal(digest.limits.tokens, [...persisted].length);
  assert(digest.limits.bytes <= digest.limits.maxBytes);
  assert(digest.limits.tokens <= digest.limits.maxTokens);
});
