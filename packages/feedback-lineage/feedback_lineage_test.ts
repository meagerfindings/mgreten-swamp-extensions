import { evaluateFeedbackLineage } from "./_lib/feedback_lineage_contracts.ts";
import {
  model,
  persistFeedbackLineage,
  validateForPersistence,
} from "./feedback_lineage.ts";

const hash = (digit: string): string => digit.repeat(64);
const copy = <T>(value: T): T => structuredClone(value);
type MutableLink = Record<string, unknown>;
type MutableFixture = Record<string, unknown> & { links: MutableLink[] };

function mutableFixture(): MutableFixture {
  return copy(fixture) as unknown as MutableFixture;
}

function linkOf(candidate: MutableFixture): MutableLink {
  return candidate.links[0];
}

function nested(
  link: MutableLink,
  field: "from" | "to" | "freshness" | "provenance",
): MutableLink {
  return link[field] as MutableLink;
}

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

async function rejects(
  fn: () => unknown | Promise<unknown>,
  text: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected ${text}`);
}

const feedback = (id: string, channel: string, hashDigit: string) => ({
  kind: "feedback" as const,
  artifactId: id,
  version: "1",
  sha256: hash(hashDigit),
  sourceIdentity: { sourceId: channel, sourceRecordId: `source-record-${id}` },
});

const fixture = {
  schemaVersion: "1.0" as const,
  recordId: "synthetic-lineage-1",
  recordVersion: "1",
  recordSha256: hash("f"),
  generatedAt: "2026-08-23T12:00:00Z",
  links: [{
    linkId: "synthetic-link-1",
    linkVersion: "1",
    linkSha256: hash("1"),
    relationship: "duplicate_of" as const,
    from: feedback("feedback-alpha", "channel-alpha", "a"),
    to: feedback("feedback-beta", "channel-beta", "b"),
    observedAt: "2026-08-23T09:00:00Z",
    linkedAt: "2026-08-23T10:00:00Z",
    provenance: {
      producer: "synthetic-validator",
      producerVersion: "1",
      method: "exact-match",
      inputArtifactIds: ["feedback-alpha", "feedback-beta"],
    },
    freshness: {
      asOf: "2026-08-23T11:00:00Z",
      expiresAt: "2026-08-24T11:00:00Z",
    },
    confidence: 0.9,
    rationale: "Equivalent synthetic symptoms remain separate source records.",
    disposition: "recommendation-only" as const,
  }],
  authority: {
    sideEffects: "none" as const,
    mayCloseSources: false as const,
    mayMergeIdentities: false as const,
    recommendationOnly: true as const,
  },
};

Deno.test("accepts a fresh, source-preserving recommendation", () => {
  const result = evaluateFeedbackLineage(fixture);
  assert(result.valid);
  assert(
    result.value.links[0].from.sourceIdentity?.sourceId === "channel-alpha",
  );
  assert(result.value.links[0].to.sourceIdentity?.sourceId === "channel-beta");
  assert(result.value.authority.mayCloseSources === false);
  assert(result.value.authority.mayMergeIdentities === false);
});

Deno.test("public arguments reject unknown fields", () => {
  assert(
    !model.methods.record.arguments.safeParse({
      persistenceId: "lineage-1",
      record: fixture,
      extra: true,
    }).success,
  );
});

Deno.test("rejects identity erasure, unsupported relationships, and self-links", () => {
  const missingIdentity = mutableFixture();
  delete nested(linkOf(missingIdentity), "from").sourceIdentity;

  const unsupportedPair = mutableFixture();
  linkOf(unsupportedPair).to = {
    kind: "decision",
    artifactId: "decision-synthetic",
    version: "1",
    sha256: hash("d"),
  };

  const selfLink = mutableFixture();
  linkOf(selfLink).to = copy(nested(linkOf(selfLink), "from"));

  for (const candidate of [missingIdentity, unsupportedPair, selfLink]) {
    assert(!evaluateFeedbackLineage(candidate).valid);
  }
});

Deno.test("rejects chronology, freshness, provenance, duplicate, and bounded-input violations", () => {
  const linkedBeforeObserved = mutableFixture();
  linkOf(linkedBeforeObserved).linkedAt = "2026-08-23T08:00:00Z";

  const staleAtGeneration = mutableFixture();
  nested(linkOf(staleAtGeneration), "freshness").expiresAt =
    "2026-08-23T11:59:59Z";

  const unboundProvenance = mutableFixture();
  nested(linkOf(unboundProvenance), "provenance").inputArtifactIds = [
    "unrelated-artifact",
  ];

  const duplicateRelationship = mutableFixture();
  duplicateRelationship.links.push({
    ...copy(linkOf(duplicateRelationship)),
    linkId: "synthetic-link-2",
    linkSha256: hash("2"),
  });

  const tooManyLinks = mutableFixture();
  tooManyLinks.links = Array.from({ length: 101 }, (_, index) => ({
    ...copy(fixture.links[0]),
    linkId: `synthetic-link-${index}`,
    linkSha256: index.toString(16).padStart(64, "0"),
  }));

  for (
    const candidate of [
      linkedBeforeObserved,
      staleAtGeneration,
      unboundProvenance,
      duplicateRelationship,
      tooManyLinks,
    ]
  ) {
    assert(!evaluateFeedbackLineage(candidate).valid);
  }
});

Deno.test("reports every validation diagnostic without silent truncation", () => {
  const invalid = mutableFixture();
  invalid.links = Array.from(
    { length: 51 },
    () => ({ relationship: "unsupported" }),
  );
  const result = evaluateFeedbackLineage(invalid);
  assert(!result.valid);
  assert(
    result.diagnostics.length > 200,
    `expected complete diagnostics, received ${result.diagnostics.length}`,
  );
});

Deno.test("rejects canonicalization rather than silently changing source identity", () => {
  const paddedIdentity = mutableFixture();
  nested(linkOf(paddedIdentity), "from").artifactId = " feedback-alpha ";
  assert(evaluateFeedbackLineage(paddedIdentity).valid);
  assert((() => {
    try {
      validateForPersistence(paddedIdentity);
      return false;
    } catch {
      return true;
    }
  })());
});

Deno.test("writes once, accepts an identical replay, and rejects conflicting replays", async () => {
  let stored: Record<string, unknown> | null = null;
  let writes = 0;
  const context = {
    readResource: (): Promise<Record<string, unknown> | null> =>
      Promise.resolve(stored),
    writeResource: (
      _spec: string,
      name: string,
      data: Record<string, unknown>,
    ): Promise<{ name: string }> => {
      writes++;
      stored = data;
      return Promise.resolve({ name });
    },
  };

  const first = await persistFeedbackLineage(
    { persistenceId: "synthetic-replay-1", record: fixture },
    context,
  );
  assert(first.dataHandles.length === 1 && writes === 1);

  const replay = await persistFeedbackLineage(
    { persistenceId: "synthetic-replay-1", record: fixture },
    context,
  );
  assert(replay.dataHandles.length === 0 && writes === 1);

  const conflict = mutableFixture();
  conflict.recordSha256 = hash("e");
  await rejects(
    () =>
      persistFeedbackLineage(
        { persistenceId: "synthetic-replay-1", record: conflict },
        context,
      ),
    "Conflicting replay",
  );
  assert(Object.keys(model.methods).join() === "record" && !("files" in model));
});
