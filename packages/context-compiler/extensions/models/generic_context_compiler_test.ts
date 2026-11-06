import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  compileOperatingPacket,
  compileRegistered,
  model,
} from "./generic_context_compiler.ts";

const authorityAttestation = "reference-only-advisory-no-authority" as const;
const replayPolicy = "reject-conflicting-replay" as const;
const digest = `sha256:${"a".repeat(64)}`;

const referenceInput = () => ({
  manifestId: "manifest-1",
  packId: "pack-1",
  purpose: "Synthetic review context",
  role: "reviewer",
  roleTaxonomy: ["reviewer", "planner"],
  evaluatedAt: "2026-08-23T12:00:00Z",
  freshnessMaxAgeSeconds: 3600,
  maxTokens: 500,
  registryRecordName: "current",
  registrySourceIds: ["example:beta", "example:alpha"],
  registryGeneratedAt: "2026-08-23T11:50:00Z",
  registryProvenance: {
    collector: "fixture",
    collectorVersion: "1",
    method: "catalog",
    collectedAt: "2026-08-23T11:50:00Z",
    contentDigest: digest,
  },
  candidates: [
    {
      sourceId: "example:beta",
      sourceVersion: "v2",
      tokenEstimate: 120,
      evidence: {
        reference: "repository://example/beta/v2",
        observedAt: "2026-08-23T11:45:00Z",
        expiresAt: "2026-08-23T13:00:00Z",
        cited: true,
        minimized: true,
      },
    },
    {
      sourceId: "example:alpha",
      sourceVersion: "v1",
      tokenEstimate: 80,
      evidence: {
        reference: "repository://example/alpha/v1",
        observedAt: "2026-08-23T11:40:00Z",
        expiresAt: "2026-08-23T12:45:00Z",
        cited: true,
        minimized: true,
      },
    },
  ],
  replayPolicy,
  authorityAttestation,
});

const packetInput = () => ({
  packetId: "packet-1",
  generatedAt: "2026-08-23T12:00:00Z",
  expiresAt: "2026-08-23T13:00:00Z",
  entries: [{
    entryId: "phase",
    kind: "current-phase",
    summary: "Synthetic state only.",
    confidence: "high" as const,
    sensitivity: "public" as const,
    observedAt: "2026-08-23T11:45:00Z",
    expiresAt: "2026-08-23T12:45:00Z",
    sourceRef: "repository://example/state/v1",
    sourceVersion: "v1",
    cited: true as const,
    minimized: true as const,
  }],
  contentAttestation: "minimized-no-secrets-no-private-content" as const,
  replayPolicy,
  authorityAttestation,
});

Deno.test("synthetic success is deterministic, sorted, fresh, bounded, and authority-free", () => {
  const first = compileRegistered(referenceInput());
  const second = compileRegistered(structuredClone(referenceInput()));
  assertEquals(first, second);
  assertEquals(first.manifest.sources.map((source) => source.sourceId), [
    "example:alpha",
    "example:beta",
  ]);
  assertEquals(first.manifest.tokenBudget.estimatedTokens, 200);
  assertEquals(first.manifest.expiresAt, "2026-08-23T12:45:00Z");
  assertEquals(first.sideEffectAuthority, "none");
});

Deno.test("stale, malformed, and tampered reference input fails closed", () => {
  const stale = referenceInput();
  stale.candidates[0].evidence.expiresAt = stale.evaluatedAt;
  assertThrows(() => compileRegistered(stale), TypeError, "stale");
  const malformed: Record<string, unknown> = referenceInput();
  malformed.unexpected = "content";
  assertThrows(() => compileRegistered(malformed));
  const tampered = referenceInput();
  tampered.candidates[0].sourceId = "example:unregistered";
  assertThrows(() => compileRegistered(tampered), TypeError, "unregistered");
  const overBudget = referenceInput();
  overBudget.maxTokens = 199;
  assertThrows(
    () => compileRegistered(overBudget),
    TypeError,
    "exceeds budget",
  );
});

Deno.test("operating packets reject stale entries and sort deterministically", () => {
  const input = packetInput();
  input.entries.push({ ...input.entries[0], entryId: "alert", kind: "risk" });
  assertEquals(
    compileOperatingPacket(input).entries.map((entry) => entry.entryId),
    ["phase", "alert"],
  );
  input.entries[0].expiresAt = input.generatedAt;
  assertThrows(() => compileOperatingPacket(input), TypeError, "stale");
});

const context = (stored: Record<string, Record<string, unknown>> = {}) => {
  const writes: unknown[][] = [];
  return {
    writes,
    value: {
      logger: {
        info: (_message: string, _properties?: Record<string, unknown>) => {},
      },
      readResource: (name: string) => Promise.resolve(stored[name] ?? null),
      writeResource: (...args: unknown[]) => {
        writes.push(args);
        return Promise.resolve({ name: args[1] });
      },
    },
  };
};

Deno.test("exact replay is idempotent and conflicting replay cannot overwrite", async () => {
  const output = compileRegistered(referenceInput());
  const exact = context({ "manifest-1": output });
  assertEquals(
    await model.methods.compileRegistered.execute(
      referenceInput(),
      exact.value,
    ),
    { dataHandles: [] },
  );
  assertEquals(exact.writes, []);

  const changed = structuredClone(output);
  changed.manifest.purpose = "Tampered replay";
  const conflict = context({ "manifest-1": changed });
  await assertRejects(
    () =>
      model.methods.compileRegistered.execute(referenceInput(), conflict.value),
    TypeError,
    "conflicting replay",
  );
  assertEquals(conflict.writes, []);
});

Deno.test("all public methods persist only authority-free local resources", async () => {
  const constitution = {
    constitution: {
      artifactId: "constitution-1",
      version: "v1",
      policyRef: "repository://example/policy/v1",
      observedAt: "2026-08-23T11:00:00Z",
      contentDigest: digest,
      cited: true as const,
      minimized: true as const,
    },
    replayPolicy,
    authorityAttestation,
  };
  for (
    const [method, input] of [["compileRegistered", referenceInput()], [
      "compileConstitution",
      constitution,
    ], ["compileOperatingPacket", packetInput()]] as const
  ) {
    const testContext = context();
    await model.methods[method].execute(input, testContext.value);
    assertEquals(testContext.writes.length, 1);
    assertEquals(
      (testContext.writes[0][2] as { sideEffectAuthority: string })
        .sideEffectAuthority,
      "none",
    );
  }
  assertEquals(JSON.stringify(model).includes("fetch"), false);
  assertEquals(JSON.stringify(model).includes("command"), false);
});
