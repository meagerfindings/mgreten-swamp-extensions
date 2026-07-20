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

/**
 * @module agent-provider-catalog
 *
 * A pure, deterministic **provider/model catalog with tiered fallback** for
 * agent-dispatch pipelines. It answers one question — *which CLI-agent
 * provider and model should a given abstract role bind for this attempt?* — and
 * does so as a versioned, caller-supplied data table rather than as scattered
 * literals.
 *
 * The catalog is **caller-supplied data** validated by {@link AgentCatalogSchema}:
 * every role maps to an ordered list of candidate `{ provider, model, costClass }`
 * tiers, where tier 0 is the default selection and each subsequent tier is the
 * next fallback. Roles are **abstract** (`implementer`, `focused-tester`,
 * `reviewer`, `verifier`, `browser`, `patcher`, `classifier`) so the catalog is
 * decoupled from any concrete deployment's review-panel names — a caller folds
 * its own concrete role names onto abstract roles with an injected map.
 *
 * The fallback layer is deliberately conservative: only throttling signals
 * (`rate-limit`, `session-limit`) advance a provider tier. A contract violation,
 * a genuine test/review failure, an infrastructure error, and a semantic decline
 * ("ran fine, the agent said no") never trigger a fallback — those belong to the
 * calling stage's own failure handling.
 *
 * This is the data companion to `@mgreten/cli-agent`: the provider set is a
 * local literal mirror of that extension's provider enum, kept as a literal so
 * this model has no runtime dependency on it.
 */

import { z } from "npm:zod@4";
import type {
  DataHandle,
  MethodContext,
  MethodResult,
} from "jsr:@systeminit/swamp-testing@0.20260604.20";

/**
 * The closed provider universe, a local literal mirror of the `@mgreten/cli-agent`
 * provider enum. Kept as a literal so this extension carries no runtime
 * dependency on cli-agent; bump the manifest version deliberately if the
 * upstream provider set changes.
 */
export const ProviderSchema: z.ZodEnum<{
  claude: "claude";
  opencode: "opencode";
  amp: "amp";
  gemini: "gemini";
  codex: "codex";
  grok: "grok";
}> = z.enum([
  "claude",
  "opencode",
  "amp",
  "gemini",
  "codex",
  "grok",
]);

/** A CLI-agent provider drawn from the closed {@link ProviderSchema} universe. */
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * The abstract agent roles a catalog can index. A new role is a deliberate
 * table row, never an ad-hoc string; callers fold their concrete role names onto
 * these with a role map (see {@link catalogRoleFor}).
 */
export const AgentRoleSchema: z.ZodEnum<{
  implementer: "implementer";
  "focused-tester": "focused-tester";
  reviewer: "reviewer";
  verifier: "verifier";
  browser: "browser";
  patcher: "patcher";
  classifier: "classifier";
}> = z.enum([
  "implementer",
  "focused-tester",
  "reviewer",
  "verifier",
  "browser",
  "patcher",
  "classifier",
]);

/** An abstract agent role. */
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * A coarse, hand-entered cost band for a candidate. Advisory metadata only —
 * selection is driven by tier order, not by cost class.
 */
export const CostClassSchema: z.ZodEnum<{
  low: "low";
  medium: "medium";
  high: "high";
}> = z.enum([
  "low",
  "medium",
  "high",
]);

/** A coarse cost band for a catalog candidate. */
export type CostClass = z.infer<typeof CostClassSchema>;

/** One candidate `{ provider, model, costClass }` in a role's ordered tier list. */
export const AgentCandidateSchema: z.ZodObject<{
  provider: typeof ProviderSchema;
  model: z.ZodString;
  costClass: typeof CostClassSchema;
  notes: z.ZodOptional<z.ZodString>;
}> = z.object({
  provider: ProviderSchema,
  model: z.string().trim().min(1),
  costClass: CostClassSchema,
  notes: z.string().trim().min(1).optional(),
}).strict();

/** One candidate in a role's ordered tier list. */
export type AgentCandidate = z.infer<typeof AgentCandidateSchema>;

/**
 * A single role's entry: an ordered, non-empty list of candidate tiers. Index 0
 * is the default selection; each subsequent index is the next fallback. A role's
 * tiers must not repeat a `{ provider, model }` pair — a fallback that lands on
 * the failing pair is pointless.
 */
export const AgentRoleEntrySchema: z.ZodObject<{
  tiers: z.ZodArray<typeof AgentCandidateSchema>;
}> = z.object({
  tiers: z.array(AgentCandidateSchema).min(1).refine(
    (tiers) =>
      new Set(tiers.map((t) => `${t.provider}/${t.model}`)).size ===
        tiers.length,
    "a role's tiers must not repeat a {provider, model} pair",
  ),
}).strict();

/** A role's ordered candidate tiers. */
export type AgentRoleEntry = z.infer<typeof AgentRoleEntrySchema>;

/**
 * The versioned, role-indexed catalog. This is **caller-supplied data**: a
 * consumer passes its own catalog (a globalArg or method argument) validated by
 * this schema. `version` is an opaque string the caller owns and bumps when it
 * changes the table.
 */
export const AgentCatalogSchema: z.ZodObject<{
  version: z.ZodString;
  roles: z.ZodRecord<typeof AgentRoleSchema, typeof AgentRoleEntrySchema>;
}> = z.object({
  version: z.string().min(1),
  // partialRecord: not every abstract role need appear in a given catalog, but
  // every key that DOES appear must be a valid abstract role (fail-closed on a
  // typo'd role name).
  roles: z.partialRecord(AgentRoleSchema, AgentRoleEntrySchema),
}).strict();

/** A versioned, role-indexed provider/model catalog. */
export type AgentCatalog = z.infer<typeof AgentCatalogSchema>;

/**
 * A small, illustrative EXAMPLE catalog. It exists to make the schema concrete
 * and to give tests and first-time callers something to run against — it is
 * **not** a production default. Real deployments supply their own catalog via a
 * globalArg or method argument validated by {@link AgentCatalogSchema}.
 */
export const EXAMPLE_AGENT_CATALOG: AgentCatalog = AgentCatalogSchema.parse({
  version: "example-1",
  roles: {
    implementer: {
      tiers: [
        { provider: "claude", model: "primary-model", costClass: "high" },
        {
          provider: "codex",
          model: "fallback-model",
          costClass: "medium",
          notes: "example fallback tier",
        },
      ],
    },
    reviewer: {
      tiers: [
        { provider: "codex", model: "review-model", costClass: "medium" },
        {
          provider: "claude",
          model: "primary-model",
          costClass: "high",
          notes: "example fallback tier",
        },
      ],
    },
    classifier: {
      tiers: [
        { provider: "claude", model: "primary-model", costClass: "high" },
      ],
    },
  },
});

/**
 * Pure selection: the candidate at `tier` for `role` in `catalog` (default tier
 * 0). Throws fail-closed on a role absent from the catalog or an out-of-range
 * tier so a caller can never silently fall through to a wrong provider.
 *
 * @param catalog A catalog validated by {@link AgentCatalogSchema}.
 * @param role The abstract role to select.
 * @param tier The 0-based tier index; 0 is the default selection.
 */
export function agentCatalogEntry(
  catalog: AgentCatalog,
  role: string,
  tier = 0,
): AgentCandidate {
  const parsedRole = AgentRoleSchema.safeParse(role);
  if (!parsedRole.success) {
    throw new Error(
      `unknown agent role "${role}" (known: ${
        AgentRoleSchema.options.join(", ")
      })`,
    );
  }
  const entry = catalog.roles[parsedRole.data];
  if (!entry) {
    throw new Error(
      `role "${role}" is not present in the supplied catalog (present: ${
        Object.keys(catalog.roles).join(", ") || "none"
      })`,
    );
  }
  const tiers = entry.tiers;
  if (!Number.isInteger(tier) || tier < 0 || tier >= tiers.length) {
    throw new Error(
      `tier ${tier} is out of range for role "${role}" (has ${tiers.length} tier(s): 0..${
        tiers.length - 1
      })`,
    );
  }
  return tiers[tier];
}

/**
 * Pure listing of a catalog (its `version` and role → ordered candidates),
 * returned as the validated catalog so an operator or agent can inspect the
 * single surface that owns selection and fallback.
 *
 * @param catalog A catalog validated by {@link AgentCatalogSchema}.
 */
export function listAgentCatalog(catalog: AgentCatalog): AgentCatalog {
  return AgentCatalogSchema.parse(catalog);
}

/**
 * The agent-invocation signal classes a fallback decision keys on. Distinct from
 * a stage's own failure taxonomy: these classify an AGENT INVOCATION signal.
 */
export const AgentSignalClassSchema: z.ZodEnum<{
  "rate-limit": "rate-limit";
  "session-limit": "session-limit";
  "contract-violation": "contract-violation";
  "test-failure": "test-failure";
  "agent-declined": "agent-declined";
  infrastructure: "infrastructure";
  unknown: "unknown";
}> = z.enum([
  "rate-limit",
  "session-limit",
  "contract-violation",
  "test-failure",
  "agent-declined",
  "infrastructure",
  "unknown",
]);

/** An agent-invocation signal class. */
export type AgentSignalClass = z.infer<typeof AgentSignalClassSchema>;

/** The policy version stamped onto every fallback decision. Bump when the trigger set changes. */
export const SIGNAL_POLICY_VERSION = "1";

/**
 * The ONLY classes that advance a fallback tier. Kept as an explicit, auditable
 * allow-list so a new trigger is a deliberate, additive edit.
 */
const FALLBACK_TRIGGER_CLASSES: ReadonlySet<AgentSignalClass> = new Set(
  ["rate-limit", "session-limit"],
);

/**
 * Whether a signal class advances a fallback tier. Only `rate-limit` and
 * `session-limit` do; every other class (and any unmodelled string) does not.
 *
 * @param signalClass The signal class to test.
 */
export function isFallbackTriggerClass(signalClass: string): boolean {
  const parsed = AgentSignalClassSchema.safeParse(signalClass);
  return parsed.success && FALLBACK_TRIGGER_CLASSES.has(parsed.data);
}

/** Options bounding a fallback decision. */
export const FallbackOptionsSchema: z.ZodObject<{
  maxAttempts: z.ZodDefault<z.ZodNumber>;
}> = z.object({
  // Hard ceiling on fallback attempts regardless of how many tiers exist, so a
  // deep catalog cannot cause unbounded re-dispatch. Default 3.
  maxAttempts: z.number().int().positive().default(3),
}).strict();

/** Options bounding a fallback decision. */
export type FallbackOptions = z.infer<typeof FallbackOptionsSchema>;

/**
 * The recorded outcome of a tiered-fallback decision for one
 * `(role, tier, signalClass, attempt)`.
 */
export const ProviderFallbackDecisionSchema: z.ZodObject<{
  role: typeof AgentRoleSchema;
  signalClass: typeof AgentSignalClassSchema;
  attempt: z.ZodNumber;
  disposition: z.ZodEnum<
    { advance: "advance"; "no-fallback": "no-fallback"; park: "park" }
  >;
  fromTier: z.ZodNumber;
  fromProvider: typeof ProviderSchema;
  fromModel: z.ZodString;
  toTier: z.ZodOptional<z.ZodNumber>;
  toProvider: z.ZodOptional<typeof ProviderSchema>;
  toModel: z.ZodOptional<z.ZodString>;
  reasons: z.ZodArray<z.ZodString>;
  maxAttempts: z.ZodNumber;
  policyVersion: z.ZodString;
  catalogVersion: z.ZodString;
  decidedAt: z.ZodString;
}> = z.object({
  role: AgentRoleSchema,
  signalClass: AgentSignalClassSchema,
  attempt: z.number().int().positive(),
  // "advance" — move to the next tier's provider/model; "no-fallback" — the
  // signal is not a fallback trigger (the stage's own failure handling owns
  // it); "park" — a trigger signal but tiers/attempts exhausted.
  disposition: z.enum(["advance", "no-fallback", "park"]),
  fromTier: z.number().int().nonnegative(),
  fromProvider: ProviderSchema,
  fromModel: z.string().min(1),
  // Present only when disposition === "advance".
  toTier: z.number().int().nonnegative().optional(),
  toProvider: ProviderSchema.optional(),
  toModel: z.string().min(1).optional(),
  reasons: z.array(z.string().min(1)),
  maxAttempts: z.number().int().positive(),
  policyVersion: z.string().min(1),
  catalogVersion: z.string().min(1),
  decidedAt: z.string().datetime(),
}).strict();

/** A recorded tiered-fallback decision. */
export type ProviderFallbackDecision = z.infer<
  typeof ProviderFallbackDecisionSchema
>;

/**
 * Pure, deterministic tiered-fallback decision. Fail-closed on an unknown role
 * or an unmodelled signal class (never silently picks a provider). A non-trigger
 * class is a no-op (`no-fallback`). A trigger class advances to the next tier
 * when one exists AND the next attempt is within `maxAttempts`; when tiers are
 * exhausted or the attempt bound is reached it parks with the full from/attempt
 * chain recorded — it never collapses onto a silent default.
 *
 * @param catalog A catalog validated by {@link AgentCatalogSchema}.
 * @param role The abstract role.
 * @param currentTier The 0-based tier the failing invocation ran on.
 * @param signalClass The classified invocation signal.
 * @param attempt The 1-based attempt number.
 * @param options Optional bounds (`maxAttempts`).
 * @param decidedAt ISO timestamp stamped on the decision (defaults to now).
 */
export function decideProviderFallback(
  catalog: AgentCatalog,
  role: string,
  currentTier: number,
  signalClass: string,
  attempt: number,
  options?: FallbackOptions,
  decidedAt: string = new Date().toISOString(),
): ProviderFallbackDecision {
  const opts = FallbackOptionsSchema.parse(options ?? {});
  const parsedSignal = AgentSignalClassSchema.safeParse(signalClass);
  if (!parsedSignal.success) {
    throw new Error(
      `unknown agent signal class "${signalClass}" (known: ${
        AgentSignalClassSchema.options.join(", ")
      }); classify it deliberately rather than defaulting a fallback`,
    );
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  // agentCatalogEntry throws fail-closed on an unknown role or out-of-range
  // tier before any decision is built.
  const from = agentCatalogEntry(catalog, role, currentTier);
  const parsedRole = AgentRoleSchema.parse(role);
  const tiers = catalog.roles[parsedRole]!.tiers;
  const signal = parsedSignal.data;

  const base = {
    role: parsedRole,
    signalClass: signal,
    attempt,
    fromTier: currentTier,
    fromProvider: from.provider,
    fromModel: from.model,
    maxAttempts: opts.maxAttempts,
    policyVersion: SIGNAL_POLICY_VERSION,
    catalogVersion: catalog.version,
    decidedAt,
  } as const;

  // 1. Not a fallback trigger: no-op. A contract violation, a genuine
  //    test/review failure, an infrastructure error, or a semantic decline
  //    must never advance a provider tier.
  if (!FALLBACK_TRIGGER_CLASSES.has(signal)) {
    return ProviderFallbackDecisionSchema.parse({
      ...base,
      disposition: "no-fallback",
      reasons: [
        `signal class "${signal}" is not a fallback trigger (only ${
          [...FALLBACK_TRIGGER_CLASSES].join(", ")
        } advance a tier); the stage's own failure handling owns this`,
      ],
    });
  }

  // 2. Attempt bound reached: park regardless of remaining tiers so a deep
  //    catalog cannot cause unbounded re-dispatch.
  if (attempt >= opts.maxAttempts) {
    return ProviderFallbackDecisionSchema.parse({
      ...base,
      disposition: "park",
      reasons: [
        `${signal} on attempt ${attempt} reached the maxAttempts bound ${opts.maxAttempts}; park for a human with the recorded chain rather than retry unbounded`,
      ],
    });
  }

  // 3. Tiers exhausted: this role has no further fallback candidate. Park.
  const nextTier = currentTier + 1;
  if (nextTier >= tiers.length) {
    return ProviderFallbackDecisionSchema.parse({
      ...base,
      disposition: "park",
      reasons: [
        `${signal} at tier ${currentTier} (${from.provider}/${from.model}) but role "${parsedRole}" has no further tier (${tiers.length} total); park for a human with the recorded chain`,
      ],
    });
  }

  // 4. Advance to the next tier's provider/model.
  const to = tiers[nextTier];
  return ProviderFallbackDecisionSchema.parse({
    ...base,
    disposition: "advance",
    toTier: nextTier,
    toProvider: to.provider,
    toModel: to.model,
    reasons: [
      `${signal} at tier ${currentTier} (${from.provider}/${from.model}); advance to tier ${nextTier} (${to.provider}/${to.model}) within maxAttempts ${opts.maxAttempts}`,
    ],
  });
}

/**
 * A caller-supplied map folding concrete (deployment-specific) role names onto
 * abstract catalog roles. Any role name present as a key is rewritten to its
 * mapped abstract role; a role name absent from the map passes through
 * unchanged (and is then validated fail-closed downstream). The identity map
 * over the abstract roles is the natural default.
 */
export type RoleMap = Readonly<Record<string, AgentRole>>;

/** The identity role map: every abstract role maps to itself. */
export const IDENTITY_ROLE_MAP: RoleMap = Object.freeze(
  Object.fromEntries(
    AgentRoleSchema.options.map((r) => [r, r]),
  ) as Record<AgentRole, AgentRole>,
);

/**
 * Map a caller-supplied role to its catalog role using an injected `roleMap`.
 * A role present in the map folds to its mapped abstract role; any other value
 * passes through unchanged and is validated fail-closed by
 * {@link agentCatalogEntry} / {@link decideProviderFallback} downstream.
 *
 * @param roleMap The injected concrete-to-abstract role map.
 * @param role The caller-supplied role name.
 */
export function catalogRoleFor(roleMap: RoleMap, role: string): string {
  return Object.prototype.hasOwnProperty.call(roleMap, role)
    ? roleMap[role]
    : role;
}

/**
 * The effective dispatch resolution a preflight step writes for one
 * `(workItem, role, attempt)`. `provider`/`model` are what the agent step binds
 * this attempt; `instanceName` is the per-role agent instance, recorded
 * untouched so distinct-instance roles can never collapse onto one instance.
 */
export const AgentDispatchResolutionSchema: z.ZodObject<{
  workItem: z.ZodString;
  role: z.ZodString;
  catalogRole: typeof AgentRoleSchema;
  instanceName: z.ZodString;
  attempt: z.ZodNumber;
  tier: z.ZodNumber;
  provider: typeof ProviderSchema;
  model: z.ZodString;
  disposition: z.ZodEnum<{
    initial: "initial";
    advance: "advance";
    "no-fallback": "no-fallback";
    park: "park";
  }>;
  parked: z.ZodBoolean;
  fallbackRef: z.ZodOptional<z.ZodString>;
  reasons: z.ZodArray<z.ZodString>;
  catalogVersion: z.ZodString;
  resolvedAt: z.ZodString;
}> = z.object({
  workItem: z.string().min(1),
  role: z.string().min(1),
  catalogRole: AgentRoleSchema,
  instanceName: z.string().trim().min(1),
  attempt: z.number().int().positive(),
  tier: z.number().int().nonnegative(),
  provider: ProviderSchema,
  model: z.string().min(1),
  disposition: z.enum(["initial", "advance", "no-fallback", "park"]),
  parked: z.boolean(),
  // Present only when a signal drove a fallback decision.
  fallbackRef: z.string().min(1).optional(),
  reasons: z.array(z.string().min(1)),
  catalogVersion: z.string().min(1),
  resolvedAt: z.string().datetime(),
}).strict();

/** An effective agent-dispatch resolution for one (workItem, role, attempt). */
export type AgentDispatchResolution = z.infer<
  typeof AgentDispatchResolutionSchema
>;

/** Arguments to {@link resolveAgentDispatch}. */
export interface ResolveAgentDispatchArgs {
  /** An opaque work-item identifier the resolution is keyed under. */
  workItem: string;
  /** The caller-supplied role name (folded to a catalog role via the role map). */
  role: string;
  /** The per-role agent instance; recorded untouched, never derived from the tier. */
  instanceName: string;
  /** The 1-based attempt number. */
  attempt: number;
  /** The 0-based tier the invocation is currently on (default 0). */
  currentTier?: number;
  /** The classified invocation signal; omit for a plain current-tier selection. */
  signalClass?: string;
  /** Optional fallback bounds (`maxAttempts`). */
  options?: FallbackOptions;
}

/**
 * Pure, deterministic dispatch resolution. Fail-closed on an unknown role or an
 * out-of-range tier (via {@link agentCatalogEntry} / {@link decideProviderFallback}).
 * With no signal it selects the current tier's `{ provider, model }`
 * byte-for-byte (the attempt-1 default preserves today's behavior). With a
 * classified signal it consults {@link decideProviderFallback}: an advance moves
 * to the next tier; a non-trigger signal stays put; an exhausted tier / attempt
 * bound parks on the current tier with `parked: true`. It NEVER derives the
 * instance from the tier — `instanceName` passes through untouched — so a
 * resolution can never collapse two distinct-instance roles onto one instance.
 *
 * @param catalog A catalog validated by {@link AgentCatalogSchema}.
 * @param roleMap The injected concrete-to-abstract role map.
 * @param args The dispatch inputs.
 * @param resolvedAt ISO timestamp stamped on the resolution (defaults to now).
 */
export function resolveAgentDispatch(
  catalog: AgentCatalog,
  roleMap: RoleMap,
  args: ResolveAgentDispatchArgs,
  resolvedAt: string = new Date().toISOString(),
): AgentDispatchResolution {
  const attempt = args.attempt;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  const currentTier = args.currentTier ?? 0;
  const catalogRole = catalogRoleFor(roleMap, args.role);
  // Fail-closed on an unknown role / out-of-range tier BEFORE any resolution.
  const current = agentCatalogEntry(catalog, catalogRole, currentTier);

  const base = {
    workItem: args.workItem,
    role: args.role,
    catalogRole: AgentRoleSchema.parse(catalogRole),
    instanceName: args.instanceName,
    attempt,
    catalogVersion: catalog.version,
    resolvedAt,
  } as const;

  // No classified signal: a plain selection at the current tier.
  if (args.signalClass === undefined) {
    return AgentDispatchResolutionSchema.parse({
      ...base,
      tier: currentTier,
      provider: current.provider,
      model: current.model,
      disposition: "initial",
      parked: false,
      reasons: [
        `no failure signal for role "${args.role}" (instance ${args.instanceName}); select tier ${currentTier} (${current.provider}/${current.model})`,
      ],
    });
  }

  // A classified signal: delegate the tier arithmetic to decideProviderFallback.
  const decision = decideProviderFallback(
    catalog,
    catalogRole,
    currentTier,
    args.signalClass,
    attempt,
    args.options,
    resolvedAt,
  );
  const fallbackRef =
    `provider-fallback-${args.workItem}-${decision.role}-${decision.attempt}`;

  if (decision.disposition === "advance") {
    return AgentDispatchResolutionSchema.parse({
      ...base,
      tier: decision.toTier!,
      provider: decision.toProvider!,
      model: decision.toModel!,
      disposition: "advance",
      parked: false,
      fallbackRef,
      reasons: [
        `role "${args.role}" (instance ${args.instanceName}) advances to tier ${decision.toTier} (${decision.toProvider}/${decision.toModel}) — instance is UNCHANGED`,
        ...decision.reasons,
      ],
    });
  }

  // no-fallback (non-trigger signal): stay on the current tier.
  if (decision.disposition === "no-fallback") {
    return AgentDispatchResolutionSchema.parse({
      ...base,
      tier: currentTier,
      provider: current.provider,
      model: current.model,
      disposition: "no-fallback",
      parked: false,
      fallbackRef,
      reasons: [
        `role "${args.role}" (instance ${args.instanceName}) stays on tier ${currentTier} (${current.provider}/${current.model}); signal is not a fallback trigger`,
        ...decision.reasons,
      ],
    });
  }

  // park: tiers/attempts exhausted. Keep the binding on the current tier and
  // flag parked so the operator sees re-dispatch is exhausted.
  return AgentDispatchResolutionSchema.parse({
    ...base,
    tier: currentTier,
    provider: current.provider,
    model: current.model,
    disposition: "park",
    parked: true,
    fallbackRef,
    reasons: [
      `role "${args.role}" (instance ${args.instanceName}) parked on tier ${currentTier} (${current.provider}/${current.model}); fallback exhausted`,
      ...decision.reasons,
    ],
  });
}

/**
 * A minimal invocation record shape the cross-cycle signal feed reads. A caller
 * hands the newest matching invocation's `success`/`failureClass`/`tags` off its
 * own telemetry model; this model only reads them, never invents a signal.
 */
export interface InvocationRecord {
  attributes?: unknown;
}

/** The invocation attributes {@link findInvocation} keys and reads. */
export const InvocationSchema: z.ZodObject<{
  invokedAt: z.ZodString;
  success: z.ZodBoolean;
  tags: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
  failureClass: z.ZodOptional<z.ZodString>;
}> = z.object({
  invokedAt: z.string(),
  success: z.boolean(),
  tags: z.record(z.string(), z.string()).optional(),
  failureClass: z.string().optional(),
}).passthrough();

/** Tag-key names the invocation lookup filters on. Both default to generic names. */
export interface SignalTagKeys {
  /** The tag key carrying the work-item identifier (default `workItem`). */
  workItem: string;
  /** The tag key carrying the phase identifier (default `phase`). */
  phase: string;
}

/** The default, generic signal tag keys (`workItem` / `phase`). */
export const DEFAULT_SIGNAL_TAG_KEYS: SignalTagKeys = Object.freeze({
  workItem: "workItem",
  phase: "phase",
});

/**
 * Pure lookup of the newest invocation for `(workItem, phase)` among `records`,
 * matching on the caller-supplied `tagKeys` (default {@link DEFAULT_SIGNAL_TAG_KEYS}).
 * Returns the parsed invocation attributes or `null` when none match.
 *
 * @param records The candidate invocation records.
 * @param workItem The work-item value to match on `tagKeys.workItem`.
 * @param phase The phase value to match on `tagKeys.phase`.
 * @param tagKeys The tag-key names to filter on.
 */
export function findInvocation(
  records: InvocationRecord[],
  workItem: string,
  phase: string,
  tagKeys: SignalTagKeys = DEFAULT_SIGNAL_TAG_KEYS,
): z.infer<typeof InvocationSchema> | null {
  return records
    .map((record) => InvocationSchema.safeParse(record.attributes))
    .filter((result) => result.success)
    .map((result) => result.data)
    .filter((invocation) =>
      invocation.tags?.[tagKeys.workItem] === workItem &&
      invocation.tags?.[tagKeys.phase] === phase
    )
    .sort((left, right) => right.invokedAt.localeCompare(left.invokedAt))[0] ??
    null;
}

/**
 * Pure lookup of the classified failure signal (if any) a resolution preflight
 * should key its next cycle's fallback decision on. Reads the newest invocation
 * for `(workItem, phase)` and returns its `failureClass` ONLY when the
 * invocation actually failed. A successful invocation, an invocation with no
 * `failureClass`, or no matching invocation all return `undefined` so the caller
 * falls through to the plain current-tier selection. Never invents a signal from
 * a success record.
 *
 * @param records The candidate invocation records.
 * @param workItem The work-item value to match.
 * @param phase The phase value to match.
 * @param tagKeys The tag-key names to filter on.
 */
export function latestFailureSignal(
  records: InvocationRecord[],
  workItem: string,
  phase: string,
  tagKeys: SignalTagKeys = DEFAULT_SIGNAL_TAG_KEYS,
): string | undefined {
  const invocation = findInvocation(records, workItem, phase, tagKeys);
  if (!invocation || invocation.success) return undefined;
  return invocation.failureClass;
}

/**
 * Global arguments for a catalog model instance. `catalog` is the caller-owned
 * provider/model table; `roleMap` folds concrete role names onto abstract roles
 * (default: identity over the abstract roles); `signalTagKeys` names the tag
 * keys the cross-cycle signal feed filters on.
 */
export const GlobalArgsSchema: z.ZodObject<{
  catalog: typeof AgentCatalogSchema;
  roleMap: z.ZodDefault<z.ZodRecord<z.ZodString, typeof AgentRoleSchema>>;
  signalTagKeys: z.ZodDefault<
    z.ZodObject<{ workItem: z.ZodString; phase: z.ZodString }>
  >;
}> = z.object({
  catalog: AgentCatalogSchema,
  roleMap: z.record(z.string(), AgentRoleSchema).default({}),
  signalTagKeys: z.object({
    workItem: z.string().min(1),
    phase: z.string().min(1),
  }).default({ workItem: "workItem", phase: "phase" }),
}).strict();

/** A catalog model instance's global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * Merge the caller's `roleMap` globalArg over the identity map so every abstract
 * role always resolves even when the caller supplies only its concrete overrides.
 */
function effectiveRoleMap(roleMap: Record<string, AgentRole>): RoleMap {
  return Object.freeze({ ...IDENTITY_ROLE_MAP, ...roleMap });
}

/** Arguments for the `recordProviderFallback` method. */
export const RecordProviderFallbackArgsSchema: z.ZodObject<{
  workItem: z.ZodString;
  role: z.ZodString;
  currentTier: z.ZodDefault<z.ZodNumber>;
  signalClass: z.ZodString;
  attempt: z.ZodDefault<z.ZodNumber>;
  options: z.ZodOptional<typeof FallbackOptionsSchema>;
}> = z.object({
  workItem: z.string().min(1),
  role: z.string().min(1),
  currentTier: z.number().int().nonnegative().default(0),
  signalClass: z.string().min(1),
  attempt: z.number().int().positive().default(1),
  options: FallbackOptionsSchema.optional(),
}).strip();

/** Arguments for the `resolveAgentDispatch` method. */
export const ResolveAgentDispatchArgsSchema: z.ZodObject<{
  workItem: z.ZodString;
  role: z.ZodString;
  instanceName: z.ZodString;
  attempt: z.ZodDefault<z.ZodNumber>;
  currentTier: z.ZodDefault<z.ZodNumber>;
  signalClass: z.ZodOptional<z.ZodString>;
  phase: z.ZodOptional<z.ZodString>;
  options: z.ZodOptional<typeof FallbackOptionsSchema>;
}> = z.object({
  workItem: z.string().min(1),
  role: z.string().min(1),
  instanceName: z.string().trim().min(1),
  attempt: z.number().int().positive().default(1),
  currentTier: z.number().int().nonnegative().default(0),
  signalClass: z.string().min(1).optional(),
  phase: z.string().min(1).optional(),
  options: FallbackOptionsSchema.optional(),
}).strip();

/**
 * The runtime context a catalog method receives: the base swamp
 * {@link MethodContext} plus a `writeResource` writer and an optional
 * `readModelData` reader used by the cross-cycle signal feed.
 */
export type CatalogContext =
  & Omit<MethodContext<GlobalArgs>, "writeResource">
  & {
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
      overrides?: { tags?: Record<string, string> },
    ) => Promise<DataHandle>;
    readModelData?: (
      modelName: string,
      specName: string,
    ) => Promise<InvocationRecord[] | undefined>;
  };

/**
 * Read the newest failed invocation's classified signal for `(workItem, phase)`
 * off a caller-named telemetry model, or `undefined` when nothing matches or the
 * reader is unavailable.
 */
async function readLatestFailureSignal(
  context: CatalogContext,
  modelName: string,
  workItem: string,
  phase: string,
  tagKeys: SignalTagKeys,
): Promise<string | undefined> {
  if (!context.readModelData) return undefined;
  const records = await context.readModelData(modelName, "invocation") ?? [];
  return latestFailureSignal(records, workItem, phase, tagKeys);
}

/**
 * The swamp model: a caller-supplied provider/model catalog with tiered
 * fallback and dispatch resolution. Every method is fail-closed and idempotent
 * per its natural key; nothing here re-dispatches a stage — the resolutions are
 * recorded follow-ups a workflow step reads.
 */
export const model = {
  type: "@mgreten/agent-provider-catalog",
  globalArgs: GlobalArgsSchema,
  data: {
    providerFallbackDecision: {
      description:
        "An advisory tiered-provider-fallback decision: for a role's agent-invocation signal it records advance/no-fallback/park, the from (and, when advancing, to) provider/model tier, the full reason chain, the attempt bound, and the catalog/policy versions; keyed by (workItem, role, attempt) and idempotent per that key. Does NOT re-dispatch any stage",
      schema: ProviderFallbackDecisionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 40,
    },
    agentDispatch: {
      description:
        "The effective agent dispatch a preflight step resolved for one (workItem, role, attempt): the {provider, model, tier} the role's agent step binds this attempt, the per-role instance recorded UNTOUCHED (so a fallback can never collapse distinct-instance roles onto fewer instances), the disposition (initial/advance/no-fallback/park) and, on a fallback, the fallbackRef into the recorded chain. Keyed by (workItem, role, attempt); idempotent per that key",
      schema: AgentDispatchResolutionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 40,
    },
  },
  methods: {
    /**
     * Decide and persist a tiered-provider-fallback decision for a role's
     * agent-invocation signal, keyed idempotently by (workItem, role, attempt).
     */
    recordProviderFallback: {
      description:
        "Decide and persist a tiered-provider-fallback decision for a role's agent-invocation signal. Only rate/session-limit signals advance a tier; contract/test/decline/infra signals are a no-op; exhausted tiers or the attempt bound park with the recorded chain. Fail-closed on an unknown role or signal class (writes no resource). Idempotent per (workItem, role, attempt). Does NOT re-dispatch the stage",
      arguments: RecordProviderFallbackArgsSchema,
      execute: async (
        args: z.infer<typeof RecordProviderFallbackArgsSchema>,
        context: CatalogContext,
      ): Promise<MethodResult> => {
        const roleMap = effectiveRoleMap(context.globalArgs.roleMap);
        const catalogRole = catalogRoleFor(roleMap, args.role);
        // decideProviderFallback throws fail-closed on an unknown role/tier or
        // an unmodelled signal class BEFORE any resource is written.
        const decision = decideProviderFallback(
          context.globalArgs.catalog,
          catalogRole,
          args.currentTier,
          args.signalClass,
          args.attempt,
          args.options,
          new Date().toISOString(),
        );
        const handle = await context.writeResource(
          "providerFallbackDecision",
          `provider-fallback-${args.workItem}-${decision.role}-${decision.attempt}`,
          decision,
          {
            tags: {
              workItem: args.workItem,
              role: decision.role,
              signalClass: decision.signalClass,
              disposition: decision.disposition,
              attempt: String(decision.attempt),
            },
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /**
     * Resolve and persist the effective {provider, model, tier} an agent step
     * should bind for one (workItem, role, attempt), optionally reading the
     * prior cycle's failed invocation signal via a caller-named telemetry model.
     */
    resolveAgentDispatch: {
      description:
        "Resolve and persist the effective {provider, model, tier} an agent " +
        "step should bind for one (workItem, role, attempt). With no signal it " +
        "selects the current tier byte-for-byte; a rate/session-limit signal " +
        "advances to the next tier; a non-trigger signal stays put; an " +
        "exhausted tier/attempt parks on the current tier with parked:true. " +
        "When the caller omits signalClass and supplies `phase`, this reads " +
        "the PRIOR cycle's invocation for (workItem, phase) off the " +
        "instanceName telemetry model and feeds its failureClass in " +
        "automatically. Records the per-role instance UNTOUCHED so a fallback " +
        "can never collapse distinct-instance roles onto fewer instances. " +
        "Fail-closed on an unknown role/tier/signal class (writes no " +
        "resource). Idempotent per (workItem, role, attempt)",
      arguments: ResolveAgentDispatchArgsSchema,
      execute: async (
        args: z.infer<typeof ResolveAgentDispatchArgsSchema>,
        context: CatalogContext,
      ): Promise<MethodResult> => {
        const roleMap = effectiveRoleMap(context.globalArgs.roleMap);
        const tagKeys = context.globalArgs.signalTagKeys;
        // Cross-cycle signal feed: only auto-read when the caller did not
        // supply an explicit signalClass (that always wins) AND opted in with
        // `phase`. The telemetry model name is the phase's own convention; the
        // caller supplies it as `phase` and we read the "invocation" spec.
        const signalClass = args.signalClass ??
          (args.phase
            ? await readLatestFailureSignal(
              context,
              args.instanceName,
              args.workItem,
              args.phase,
              tagKeys,
            )
            : undefined);
        const resolution = resolveAgentDispatch(
          context.globalArgs.catalog,
          roleMap,
          {
            workItem: args.workItem,
            role: args.role,
            instanceName: args.instanceName,
            attempt: args.attempt,
            currentTier: args.currentTier,
            signalClass,
            options: args.options,
          },
          new Date().toISOString(),
        );
        const handle = await context.writeResource(
          "agentDispatch",
          `agent-dispatch-${args.workItem}-${resolution.role}-${resolution.attempt}`,
          resolution,
          {
            tags: {
              workItem: args.workItem,
              role: resolution.role,
              instanceName: resolution.instanceName,
              disposition: resolution.disposition,
              attempt: String(resolution.attempt),
            },
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
