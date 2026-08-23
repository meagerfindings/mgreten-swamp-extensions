/** Synthetic contract and persistence tests for decision records. */
import { DecisionRecord, model, persistDecision } from "./decision_record.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

async function rejects(
  fn: () => Promise<unknown>,
  text: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected rejection: ${text}`);
}

const hash = "a".repeat(64);
const base = (
  decision: "accept" | "defer" | "reject" | "evidence-needed" = "accept",
) => ({
  schemaVersion: "1.0",
  decisionId: "decision-1",
  proposalId: "idea-1",
  dossier: {
    dossierId: "dossier-1",
    version: 3,
    sha256: hash,
    subject: {
      kind: "product-idea",
      id: "idea-1",
      version: 2,
      sha256: "b".repeat(64),
    },
  },
  actor: { id: "human-1", role: "product owner", humanAuthority: true },
  decision,
  rationale: "Explicit human judgment.",
  conditions: [],
  evidenceNeeded: [],
  newEvidenceReferences: [],
  decidedAt: "2026-08-17T12:00:00Z",
  reviewAt: "2026-09-17T12:00:00Z",
  authority: {
    source: "explicit-human-input",
    inferred: false,
    mayExecute: false,
    sideEffects: "persist-record-only",
  },
});

function context(
  stored: Record<string, Record<string, unknown>> = {},
  failWrite?: number,
) {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    writes,
    api: {
      readResource: (name: string) => Promise.resolve(stored[name] ?? null),
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data });
        if (writes.length === failWrite) {
          return Promise.reject(new Error("injected write failure"));
        }
        stored[name] = structuredClone(data);
        return Promise.resolve({ name });
      },
    },
  };
}

Deno.test("requires exact dossier identity and explicit human zero-authority record", () => {
  assert(DecisionRecord.safeParse(base()).success);
  assert(
    !DecisionRecord.safeParse({
      ...base(),
      dossier: { ...base().dossier, sha256: "bad" },
    }).success,
  );
  assert(
    !DecisionRecord.safeParse({
      ...base(),
      actor: { ...base().actor, humanAuthority: false },
    }).success,
  );
  assert(
    !DecisionRecord.safeParse({
      ...base(),
      authority: { ...base().authority, inferred: true },
    }).success,
  );
  assert(
    !DecisionRecord.safeParse({
      ...base(),
      authority: { ...base().authority, mayExecute: true },
    }).success,
  );
});

Deno.test("public arguments reject unknown fields", () => {
  assert(
    !model.methods.record.arguments.safeParse({ record: base(), extra: true })
      .success,
  );
});

Deno.test("evidence-needed details, unique evidence, and review chronology fail closed", () => {
  assert(!DecisionRecord.safeParse(base("evidence-needed")).success);
  assert(
    DecisionRecord.safeParse({
      ...base("evidence-needed"),
      evidenceNeeded: ["Current retention cohort"],
    }).success,
  );
  assert(
    !DecisionRecord.safeParse({ ...base(), evidenceNeeded: ["not allowed"] })
      .success,
  );
  assert(
    !DecisionRecord.safeParse({ ...base(), reviewAt: "2026-08-16T12:00:00Z" })
      .success,
  );
  assert(
    !DecisionRecord.safeParse({
      ...base(),
      newEvidenceReferences: [
        {
          evidenceId: "evidence-1",
          sourceId: "research-1",
          version: "1",
          sha256: "c".repeat(64),
        },
        {
          evidenceId: "evidence-1",
          sourceId: "research-2",
          version: "1",
          sha256: "d".repeat(64),
        },
      ],
    }).success,
  );
});

Deno.test("persists supplied record only and makes an exact replay idempotent", async () => {
  const first = context();
  const result = await persistDecision({ record: base() }, first.api);
  assert(first.writes.length === 2);
  assert(
    first.writes[0].spec === "decision" &&
      first.writes[0].name === "decision-decision-1",
  );
  assert(
    first.writes[1].spec === "latestDecision" &&
      first.writes[1].name === "proposal-idea-1",
  );
  assert(result.dataHandles.length === 2);

  const replay = context({ "decision-decision-1": base() });
  const replayResult = await persistDecision({ record: base() }, replay.api);
  assert(replay.writes.length === 1);
  assert(replay.writes[0].spec === "latestDecision");
  assert(replayResult.dataHandles.length === 1);
  await rejects(
    () =>
      persistDecision(
        { record: { ...base(), rationale: "Changed" } },
        replay.api,
      ),
    "Conflicting replay",
  );
});

Deno.test("replay repairs latestDecision after the second write failed", async () => {
  const stored: Record<string, Record<string, unknown>> = {};
  const interrupted = context(stored, 2);
  await rejects(
    () => persistDecision({ record: base() }, interrupted.api),
    "injected write failure",
  );
  assert(stored["decision-decision-1"] !== undefined);
  assert(stored["proposal-idea-1"] === undefined);

  const replay = context(stored);
  const result = await persistDecision({ record: base() }, replay.api);
  assert(replay.writes.length === 1);
  assert(replay.writes[0].name === "proposal-idea-1");
  assert(result.dataHandles.length === 1);
  assert(stored["proposal-idea-1"] !== undefined);
});

Deno.test("requires decisions to advance chronologically for a proposal", async () => {
  const prior = { ...base("defer"), decisionId: "prior" };
  const current = context({ "proposal-idea-1": prior });
  await rejects(
    () =>
      persistDecision(
        { record: { ...base(), decisionId: "same-time" } },
        current.api,
      ),
    "chronologically",
  );
  await rejects(
    () =>
      persistDecision({
        record: {
          ...base(),
          decisionId: "earlier",
          decidedAt: "2026-08-16T12:00:00Z",
        },
      }, current.api),
    "chronologically",
  );
});

Deno.test("a rejected proposal requires new evidence and a newer changed dossier", async () => {
  const rejected = { ...base("reject"), decisionId: "old-rejection" };
  const next = {
    ...base(),
    decisionId: "decision-2",
    dossier: { ...base().dossier, version: 4, sha256: "d".repeat(64) },
    decidedAt: "2026-08-18T12:00:00Z",
    reviewAt: "2026-09-18T12:00:00Z",
  };
  await rejects(
    () =>
      persistDecision(
        { record: next },
        context({ "proposal-idea-1": rejected }).api,
      ),
    "new-evidence reference",
  );
  await rejects(
    () =>
      persistDecision({
        record: {
          ...next,
          newEvidenceReferences: [{
            evidenceId: "evidence-2",
            sourceId: "research-1",
            version: "2",
            sha256: "c".repeat(64),
          }],
          dossier: { ...next.dossier, version: 3 },
        },
      }, context({ "proposal-idea-1": rejected }).api),
    "newer changed dossier",
  );
  await rejects(() =>
    persistDecision({
      record: {
        ...next,
        newEvidenceReferences: [{
          evidenceId: "evidence-2",
          sourceId: "research-1",
          version: "2",
          sha256: "c".repeat(64),
        }],
        dossier: { ...next.dossier, sha256: hash },
      },
    }, context({ "proposal-idea-1": rejected }).api), "newer changed dossier");

  const allowed = context({ "proposal-idea-1": rejected });
  await persistDecision({
    record: {
      ...next,
      newEvidenceReferences: [{
        evidenceId: "evidence-2",
        sourceId: "research-1",
        version: "2",
        sha256: "c".repeat(64),
      }],
    },
  }, allowed.api);
  assert(allowed.writes.length === 2);
});
