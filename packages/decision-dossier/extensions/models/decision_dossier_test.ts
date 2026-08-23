import { syntheticDossier } from "./_lib/fixture.ts";
import { model, persistDossier } from "./decision_dossier.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => Promise<unknown>, message: string) {
  try {
    await fn();
  } catch (error) {
    assert(String(error).includes(message), String(error));
    return;
  }
  throw new Error(`expected ${message}`);
}
function context(prior: Record<string, unknown> | null = null) {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    writes,
    api: {
      logger: { info: () => undefined },
      readResource: () => Promise.resolve(prior),
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

Deno.test("records only validated dossiers at an opaque, stable resource identity", async () => {
  const target = context();
  const result = await persistDossier(
    { dossier: syntheticDossier },
    target.api,
  );
  assert(target.writes.length === 1);
  assert(target.writes[0].spec === "dossier");
  assert(/^dossier-[0-9a-f]{32}$/.test(target.writes[0].name));
  assert(target.writes[0].data.dossierId === syntheticDossier.dossierId);
  assert(result.dataHandles.length === 1);
});

Deno.test("is idempotent for replays and fails closed for invalid updates", async () => {
  const replay = context(structuredClone(syntheticDossier));
  const result = await persistDossier(
    { dossier: syntheticDossier },
    replay.api,
  );
  assert(result.dataHandles.length === 0 && replay.writes.length === 0);
  const reordered = structuredClone(syntheticDossier);
  reordered.options.reverse();
  reordered.economics.estimates.reverse();
  const reorderedReplay = context(structuredClone(syntheticDossier));
  const reorderedResult = await persistDossier(
    { dossier: reordered },
    reorderedReplay.api,
  );
  assert(
    reorderedResult.dataHandles.length === 0 &&
      reorderedReplay.writes.length === 0,
  );
  const changed = structuredClone(syntheticDossier);
  changed.problem.statement = "Changed without a new version";
  await rejects(
    () => persistDossier({ dossier: changed }, context(syntheticDossier).api),
    "version must increase",
  );
  const malformed = structuredClone(syntheticDossier) as Record<
    string,
    unknown
  >;
  malformed.extra = true;
  await rejects(
    () => persistDossier({ dossier: malformed }, context().api),
    "Unrecognized key",
  );
});

Deno.test("requires monotonic version, stable subject identity, and chronology", async () => {
  const next = structuredClone(syntheticDossier);
  next.version = 2;
  next.createdAt = "2026-01-04T12:00:00Z";
  assert(
    (await persistDossier({ dossier: next }, context(syntheticDossier).api))
      .dataHandles.length === 1,
  );
  const changedSubject = structuredClone(next);
  changedSubject.subject.id = "another-subject";
  await rejects(
    () =>
      persistDossier(
        { dossier: changedSubject },
        context(syntheticDossier).api,
      ),
    "cannot change its subject identity",
  );
  const changedArtifact = structuredClone(next);
  changedArtifact.subject.sha256 = "b".repeat(64);
  await rejects(
    () =>
      persistDossier(
        { dossier: changedArtifact },
        context(syntheticDossier).api,
      ),
    "cannot change its subject identity",
  );
  const stale = structuredClone(next);
  stale.createdAt = syntheticDossier.createdAt;
  await rejects(
    () => persistDossier({ dossier: stale }, context(syntheticDossier).api),
    "createdAt must follow",
  );
});

Deno.test("exposes persistence only; no decision or action method exists", () => {
  assert(Object.keys(model.methods).join() === "record");
  assert(Object.keys(model.resources).join() === "dossier");
  assert(model.type === "@mgreten/decision-dossier");
});

Deno.test("fails closed for malformed or tampered stored state", async () => {
  const next = structuredClone(syntheticDossier);
  next.version = 2;
  next.createdAt = "2026-01-04T12:00:00Z";
  const tampered = context({ dossierId: "tampered" });
  await rejects(
    () => persistDossier({ dossier: next }, tampered.api),
    "Invalid input",
  );
  assert(tampered.writes.length === 0);
});
