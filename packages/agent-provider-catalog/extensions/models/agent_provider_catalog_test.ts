// MIT License
//
// Copyright (c) 2026 Mat Greten
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  type AgentCandidate,
  type AgentCatalog,
  agentCatalogEntry,
  AgentCatalogSchema,
  AgentDispatchResolutionSchema,
  catalogRoleFor,
  decideProviderFallback,
  findInvocation,
  IDENTITY_ROLE_MAP,
  isFallbackTriggerClass,
  latestFailureSignal,
  listAgentCatalog,
  ProviderFallbackDecisionSchema,
  type RoleMap,
  resolveAgentDispatch,
} from "./agent_provider_catalog.ts";

// A deterministic test catalog. Two multi-tier roles (implementer, reviewer)
// and one single-tier role (classifier), all within the closed provider set.
const CATALOG: AgentCatalog = AgentCatalogSchema.parse({
  version: "test-1",
  roles: {
    implementer: {
      tiers: [
        { provider: "claude", model: "opus", costClass: "high" },
        { provider: "codex", model: "gpt-5.5", costClass: "medium" },
      ],
    },
    reviewer: {
      tiers: [
        { provider: "codex", model: "gpt-5.5", costClass: "medium" },
        { provider: "claude", model: "opus", costClass: "high" },
      ],
    },
    classifier: {
      tiers: [{ provider: "claude", model: "opus", costClass: "high" }],
    },
  },
});

// A caller-supplied role map folding four concrete review-panel role names onto
// the abstract "reviewer" role, layered over identity so other roles pass
// through. This is the parameterized replacement for a hardcoded panel table.
const ROLE_MAP: RoleMap = Object.freeze({
  ...IDENTITY_ROLE_MAP,
  correctness: "reviewer",
  security: "reviewer",
  design: "reviewer",
  testing: "reviewer",
});

const CLOSED_PROVIDERS = new Set([
  "claude",
  "opencode",
  "amp",
  "gemini",
  "codex",
  "grok",
]);

Deno.test("listAgentCatalog: returns the supplied catalog and it parses AgentCatalogSchema", () => {
  const catalog = listAgentCatalog(CATALOG);
  assertEquals(catalog.version, "test-1");
  assert(AgentCatalogSchema.safeParse(catalog).success);
});

Deno.test("agentCatalogEntry: every catalogued role resolves at tier 0 within the closed provider universe", () => {
  for (const role of Object.keys(CATALOG.roles)) {
    const entry = agentCatalogEntry(CATALOG, role, 0);
    assert(CLOSED_PROVIDERS.has(entry.provider), `${role} provider`);
    assert(entry.model.length > 0, `${role} model`);
  }
  const allProviders = new Set(
    Object.values(CATALOG.roles).flatMap((r) =>
      r.tiers.map((t: AgentCandidate) => t.provider)
    ),
  );
  for (const provider of allProviders) {
    assert(CLOSED_PROVIDERS.has(provider), `unknown provider ${provider}`);
  }
});

Deno.test("AgentCatalogSchema rejects a role whose tiers repeat a {provider, model} pair", () => {
  const dup = {
    version: "test-1",
    roles: {
      implementer: {
        tiers: [
          { provider: "claude", model: "opus", costClass: "high" },
          { provider: "claude", model: "opus", costClass: "high" },
        ],
      },
    },
  };
  assertEquals(AgentCatalogSchema.safeParse(dup).success, false);
});

Deno.test("agentCatalogEntry throws on an unknown role", () => {
  assertThrows(
    () => agentCatalogEntry(CATALOG, "not-a-role"),
    Error,
    "unknown agent role",
  );
});

Deno.test("agentCatalogEntry throws on a role absent from the supplied catalog", () => {
  assertThrows(
    () => agentCatalogEntry(CATALOG, "browser"),
    Error,
    "not present in the supplied catalog",
  );
});

Deno.test("agentCatalogEntry throws on an out-of-range tier (too high or negative)", () => {
  assertThrows(() => agentCatalogEntry(CATALOG, "reviewer", 99), Error);
  assertThrows(() => agentCatalogEntry(CATALOG, "reviewer", -1), Error);
});

Deno.test("catalogRoleFor: concrete panel roles fold to reviewer; unmapped roles pass through", () => {
  assertEquals(catalogRoleFor(ROLE_MAP, "correctness"), "reviewer");
  assertEquals(catalogRoleFor(ROLE_MAP, "security"), "reviewer");
  assertEquals(catalogRoleFor(ROLE_MAP, "reviewer"), "reviewer");
  assertEquals(catalogRoleFor(ROLE_MAP, "implementer"), "implementer");
  // An unknown role passes through untouched (validated fail-closed downstream).
  assertEquals(catalogRoleFor(ROLE_MAP, "not-a-role"), "not-a-role");
});

Deno.test("isFallbackTriggerClass: only rate-limit and session-limit trigger a fallback", () => {
  for (const trigger of ["rate-limit", "session-limit"]) {
    assert(isFallbackTriggerClass(trigger), trigger);
  }
  for (
    const nonTrigger of [
      "contract-violation",
      "test-failure",
      "agent-declined",
      "infrastructure",
      "unknown",
      "totally-bogus-class",
    ]
  ) {
    assert(!isFallbackTriggerClass(nonTrigger), nonTrigger);
  }
});

Deno.test("decideProviderFallback: rate-limit and session-limit at tier 0 advance a 2-tier role", () => {
  const decidedAt = "2026-07-18T00:00:00.000Z";
  for (const signal of ["rate-limit", "session-limit"]) {
    const decision = decideProviderFallback(
      CATALOG,
      "reviewer",
      0,
      signal,
      1,
      undefined,
      decidedAt,
    );
    assertEquals(decision.disposition, "advance", signal);
    assertEquals(decision.fromTier, 0);
    assertEquals(decision.fromProvider, "codex");
    assertEquals(decision.fromModel, "gpt-5.5");
    assertEquals(decision.toTier, 1);
    assertEquals(decision.toProvider, "claude");
    assertEquals(decision.toModel, "opus");
    assertEquals(decision.decidedAt, decidedAt);
    assertEquals(decision.catalogVersion, "test-1");
  }
});

Deno.test("decideProviderFallback: a non-trigger signal class is always no-fallback with toTier/toProvider/toModel absent", () => {
  const decidedAt = "2026-07-18T00:00:00.000Z";
  for (
    const signal of [
      "test-failure",
      "contract-violation",
      "agent-declined",
      "infrastructure",
      "unknown",
    ]
  ) {
    const decision = decideProviderFallback(
      CATALOG,
      "reviewer",
      0,
      signal,
      1,
      undefined,
      decidedAt,
    );
    assertEquals(decision.disposition, "no-fallback", signal);
    assertEquals(decision.toTier, undefined, signal);
    assertEquals(decision.toProvider, undefined, signal);
    assertEquals(decision.toModel, undefined, signal);
  }
});

Deno.test("decideProviderFallback: a single-tier role (classifier) parks immediately on a trigger signal (tiers exhausted)", () => {
  const decision = decideProviderFallback(
    CATALOG,
    "classifier",
    0,
    "rate-limit",
    1,
    undefined,
    "2026-07-18T00:00:00.000Z",
  );
  assertEquals(decision.disposition, "park");
  assertEquals(decision.toTier, undefined);
});

Deno.test("decideProviderFallback: attempt >= maxAttempts parks even when a next tier exists (attempt bound wins)", () => {
  const decision = decideProviderFallback(
    CATALOG,
    "reviewer",
    0,
    "rate-limit",
    3,
    undefined,
    "2026-07-18T00:00:00.000Z",
  );
  assertEquals(decision.disposition, "park");
  assertEquals(decision.toTier, undefined);
});

Deno.test("decideProviderFallback: a custom maxAttempts of 1 parks at attempt 1", () => {
  const decision = decideProviderFallback(
    CATALOG,
    "reviewer",
    0,
    "rate-limit",
    1,
    { maxAttempts: 1 },
    "2026-07-18T00:00:00.000Z",
  );
  assertEquals(decision.disposition, "park");
  assertEquals(decision.toTier, undefined);
});

Deno.test("decideProviderFallback: every returned decision parses ProviderFallbackDecisionSchema and JSON round-trips without loss", () => {
  const decidedAt = "2026-07-18T00:00:00.000Z";
  const cases: Array<[string, number, string, number]> = [
    ["reviewer", 0, "rate-limit", 1],
    ["reviewer", 0, "session-limit", 1],
    ["reviewer", 0, "test-failure", 1],
    ["classifier", 0, "rate-limit", 1],
    ["reviewer", 0, "rate-limit", 3],
  ];
  for (const [role, tier, signal, attempt] of cases) {
    const decision = decideProviderFallback(
      CATALOG,
      role,
      tier,
      signal,
      attempt,
      undefined,
      decidedAt,
    );
    assert(
      ProviderFallbackDecisionSchema.safeParse(decision).success,
      `${role}/${signal}/${attempt}`,
    );
    const json = JSON.stringify(decision);
    const roundTripped = JSON.parse(json);
    assertEquals(roundTripped, decision, `${role}/${signal}/${attempt}`);
  }
});

Deno.test("decideProviderFallback throws on an unknown role", () => {
  assertThrows(
    () => decideProviderFallback(CATALOG, "not-a-role", 0, "rate-limit", 1),
    Error,
  );
});

Deno.test("decideProviderFallback throws on an unknown signal class", () => {
  assertThrows(
    () => decideProviderFallback(CATALOG, "reviewer", 0, "made-up", 1),
    Error,
    "unknown agent signal class",
  );
});

Deno.test("decideProviderFallback throws on a non-positive attempt", () => {
  assertThrows(
    () => decideProviderFallback(CATALOG, "reviewer", 0, "rate-limit", 0),
    Error,
  );
  assertThrows(
    () => decideProviderFallback(CATALOG, "reviewer", 0, "rate-limit", -1),
    Error,
  );
});

Deno.test("resolveAgentDispatch: no signal selects the current tier byte-for-byte (attempt-1 default)", () => {
  const at = "2026-07-18T00:00:00.000Z";
  // Each concrete review role folds (via ROLE_MAP) to the catalog "reviewer"
  // tier 0 = codex/gpt-5.5 — omitting a signal changes nothing.
  for (const role of ["correctness", "security", "design", "testing"]) {
    const r = resolveAgentDispatch(
      CATALOG,
      ROLE_MAP,
      {
        workItem: "WI-900",
        role,
        instanceName: `review-agent-${role}`,
        attempt: 1,
      },
      at,
    );
    assertEquals(r.disposition, "initial", role);
    assertEquals(r.catalogRole, "reviewer", role);
    assertEquals(r.tier, 0, role);
    assertEquals(r.provider, "codex", role);
    assertEquals(r.model, "gpt-5.5", role);
    assertEquals(r.parked, false, role);
    assertEquals(r.instanceName, `review-agent-${role}`, role);
    assertEquals(r.fallbackRef, undefined, role);
  }
});

Deno.test("resolveAgentDispatch: a rate/session-limit signal advances a reviewer role to tier 1 without touching the instance", () => {
  const at = "2026-07-18T00:00:00.000Z";
  for (const signal of ["rate-limit", "session-limit"]) {
    const r = resolveAgentDispatch(
      CATALOG,
      ROLE_MAP,
      {
        workItem: "WI-901",
        role: "security",
        instanceName: "review-agent-security",
        attempt: 1,
        currentTier: 0,
        signalClass: signal,
      },
      at,
    );
    assertEquals(r.disposition, "advance", signal);
    assertEquals(r.tier, 1, signal);
    assertEquals(r.provider, "claude", signal);
    assertEquals(r.model, "opus", signal);
    assertEquals(r.parked, false, signal);
    assertEquals(r.instanceName, "review-agent-security", signal);
    assertEquals(r.fallbackRef, "provider-fallback-WI-901-reviewer-1", signal);
  }
});

Deno.test("resolveAgentDispatch: a fallback never collapses two distinct-instance roles onto one instance", () => {
  const at = "2026-07-18T00:00:00.000Z";
  const roles = ["correctness", "security", "design", "testing"] as const;

  const tier0 = roles.map((role) =>
    resolveAgentDispatch(
      CATALOG,
      ROLE_MAP,
      {
        workItem: "WI-902",
        role,
        instanceName: `review-agent-${role}`,
        attempt: 1,
      },
      at,
    )
  );
  const tier1 = roles.map((role) =>
    resolveAgentDispatch(
      CATALOG,
      ROLE_MAP,
      {
        workItem: "WI-902",
        role,
        instanceName: `review-agent-${role}`,
        attempt: 1,
        currentTier: 0,
        signalClass: "rate-limit",
      },
      at,
    )
  );

  for (const layer of [tier0, tier1]) {
    const pairs = new Set(layer.map((r) => `${r.provider}/${r.model}`));
    assertEquals(pairs.size, 1);
    const instances = new Set(layer.map((r) => r.instanceName));
    assertEquals(instances.size, roles.length);
    for (let i = 0; i < roles.length; i++) {
      assertEquals(layer[i].instanceName, `review-agent-${roles[i]}`);
    }
  }
  assertEquals(
    new Set(tier0.map((r) => r.instanceName)),
    new Set(tier1.map((r) => r.instanceName)),
  );
});

Deno.test("resolveAgentDispatch: a non-trigger signal stays on the current tier (no-fallback) with the instance intact", () => {
  const at = "2026-07-18T00:00:00.000Z";
  for (
    const signal of [
      "test-failure",
      "contract-violation",
      "agent-declined",
      "infrastructure",
      "unknown",
    ]
  ) {
    const r = resolveAgentDispatch(
      CATALOG,
      ROLE_MAP,
      {
        workItem: "WI-903",
        role: "design",
        instanceName: "review-agent-design",
        attempt: 1,
        currentTier: 0,
        signalClass: signal,
      },
      at,
    );
    assertEquals(r.disposition, "no-fallback", signal);
    assertEquals(r.tier, 0, signal);
    assertEquals(r.provider, "codex", signal);
    assertEquals(r.model, "gpt-5.5", signal);
    assertEquals(r.parked, false, signal);
    assertEquals(r.instanceName, "review-agent-design", signal);
  }
});

Deno.test("resolveAgentDispatch: an exhausted tier / attempt bound parks on the current tier with parked:true", () => {
  const at = "2026-07-18T00:00:00.000Z";
  const exhausted = resolveAgentDispatch(
    CATALOG,
    ROLE_MAP,
    {
      workItem: "WI-904",
      role: "correctness",
      instanceName: "review-agent-correctness",
      attempt: 1,
      currentTier: 1,
      signalClass: "rate-limit",
    },
    at,
  );
  assertEquals(exhausted.disposition, "park");
  assertEquals(exhausted.parked, true);
  assertEquals(exhausted.tier, 1);
  assertEquals(exhausted.provider, "claude");
  assertEquals(exhausted.model, "opus");
  assertEquals(exhausted.instanceName, "review-agent-correctness");

  const bound = resolveAgentDispatch(
    CATALOG,
    ROLE_MAP,
    {
      workItem: "WI-904",
      role: "correctness",
      instanceName: "review-agent-correctness",
      attempt: 3,
      currentTier: 0,
      signalClass: "rate-limit",
    },
    at,
  );
  assertEquals(bound.disposition, "park");
  assertEquals(bound.parked, true);
  assertEquals(bound.tier, 0);
});

Deno.test("resolveAgentDispatch: every resolution parses its schema and JSON round-trips without loss", () => {
  const at = "2026-07-18T00:00:00.000Z";
  const cases: Array<Parameters<typeof resolveAgentDispatch>[2]> = [
    { workItem: "WI-905", role: "correctness", instanceName: "i-c", attempt: 1 },
    {
      workItem: "WI-905",
      role: "security",
      instanceName: "i-s",
      attempt: 1,
      signalClass: "rate-limit",
    },
    {
      workItem: "WI-905",
      role: "design",
      instanceName: "i-d",
      attempt: 1,
      signalClass: "test-failure",
    },
    {
      workItem: "WI-905",
      role: "testing",
      instanceName: "i-t",
      attempt: 1,
      currentTier: 1,
      signalClass: "session-limit",
    },
  ];
  for (const c of cases) {
    const r = resolveAgentDispatch(CATALOG, ROLE_MAP, c, at);
    assert(
      AgentDispatchResolutionSchema.safeParse(r).success,
      `${c.role}/${c.signalClass ?? "none"}`,
    );
    assertEquals(JSON.parse(JSON.stringify(r)), r, c.role);
  }
});

Deno.test("resolveAgentDispatch fails closed on an unknown role, an out-of-range tier, and an unknown signal class", () => {
  assertThrows(
    () =>
      resolveAgentDispatch(CATALOG, ROLE_MAP, {
        workItem: "WI-906",
        role: "not-a-role",
        instanceName: "i",
        attempt: 1,
      }),
    Error,
  );
  assertThrows(
    () =>
      resolveAgentDispatch(CATALOG, ROLE_MAP, {
        workItem: "WI-906",
        role: "correctness",
        instanceName: "i",
        attempt: 1,
        currentTier: 9,
      }),
    Error,
  );
  assertThrows(
    () =>
      resolveAgentDispatch(CATALOG, ROLE_MAP, {
        workItem: "WI-906",
        role: "correctness",
        instanceName: "i",
        attempt: 1,
        signalClass: "totally-bogus-class",
      }),
    Error,
  );
});

Deno.test("findInvocation: selects the newest matching record on the caller's tag keys", () => {
  const records = [
    {
      attributes: {
        invokedAt: "2026-07-18T00:00:00.000Z",
        success: false,
        failureClass: "rate-limit",
        tags: { workItem: "WI-1", phase: "implement" },
      },
    },
    {
      attributes: {
        invokedAt: "2026-07-19T00:00:00.000Z",
        success: true,
        tags: { workItem: "WI-1", phase: "implement" },
      },
    },
    {
      attributes: {
        invokedAt: "2026-07-20T00:00:00.000Z",
        success: false,
        failureClass: "session-limit",
        tags: { workItem: "WI-2", phase: "implement" },
      },
    },
  ];
  const found = findInvocation(records, "WI-1", "implement");
  assertEquals(found?.invokedAt, "2026-07-19T00:00:00.000Z");
  assertEquals(found?.success, true);
  assertEquals(findInvocation(records, "WI-3", "implement"), null);
});

Deno.test("findInvocation: honors custom tag-key names", () => {
  const records = [
    {
      attributes: {
        invokedAt: "2026-07-18T00:00:00.000Z",
        success: false,
        failureClass: "rate-limit",
        tags: { ticket: "T-9", stage: "review" },
      },
    },
  ];
  const found = findInvocation(records, "T-9", "review", {
    workItem: "ticket",
    phase: "stage",
  });
  assertEquals(found?.failureClass, "rate-limit");
  // Default keys must not match the custom-keyed record.
  assertEquals(findInvocation(records, "T-9", "review"), null);
});

Deno.test("latestFailureSignal: returns failureClass only for the newest FAILED invocation", () => {
  const failed = [
    {
      attributes: {
        invokedAt: "2026-07-18T00:00:00.000Z",
        success: false,
        failureClass: "rate-limit",
        tags: { workItem: "WI-1", phase: "implement" },
      },
    },
  ];
  assertEquals(latestFailureSignal(failed, "WI-1", "implement"), "rate-limit");

  // Newest is a success => no signal (never invents one from a success record).
  const successNewest = [
    ...failed,
    {
      attributes: {
        invokedAt: "2026-07-19T00:00:00.000Z",
        success: true,
        tags: { workItem: "WI-1", phase: "implement" },
      },
    },
  ];
  assertEquals(
    latestFailureSignal(successNewest, "WI-1", "implement"),
    undefined,
  );

  // No matching record => undefined.
  assertEquals(latestFailureSignal(failed, "WI-9", "implement"), undefined);
});
