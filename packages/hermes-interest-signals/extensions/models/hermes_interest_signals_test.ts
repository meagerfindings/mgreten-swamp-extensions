import { assertEquals } from "jsr:@std/assert@1";
import {
  aggregateObservations,
  normalizeTopic,
  recencyMultiplier,
  renderProfile,
} from "./hermes_interest_signals.ts";

const settings = { minimumActiveScore: 3, maxInterests: 10 };

Deno.test("normalizes equivalent topic labels", () => {
  assertEquals(normalizeTopic("  Home   Automation  "), "home automation");
});

Deno.test("weights recent signals above old signals", () => {
  assertEquals(recencyMultiplier(0), 3);
  assertEquals(recencyMultiplier(60), 2);
  assertEquals(recencyMultiplier(120), 1);
});

Deno.test("aggregates active and declined interests transparently", () => {
  const profile = aggregateObservations([
    {
      topic: "Home Automation",
      kind: "active-project",
      confidence: 2,
      recencyDays: 4,
      rationale: "A current project is being discussed",
    },
    {
      topic: "Legacy Service",
      kind: "declined",
      confidence: 2,
      recencyDays: 5,
      rationale: "The user explicitly stopped using it",
    },
  ], settings);
  assertEquals(profile.activeInterests[0]?.topic, "Home Automation");
  assertEquals(profile.deprioritizedInterests[0]?.topic, "Legacy Service");
  assertEquals(profile.downstreamSignals, [
    {
      term: "Home Automation",
      direction: "promote",
      weight: 3,
      rationale: "A current project is being discussed",
    },
    {
      term: "Legacy Service",
      direction: "deprioritize",
      weight: 2,
      rationale: "The user explicitly stopped using it",
    },
  ]);
});

Deno.test("renders a human-reviewable profile", () => {
  const profile = aggregateObservations([{
    topic: "Example Topic",
    kind: "interest",
    confidence: 1,
    recencyDays: 10,
    rationale: "Explicitly mentioned",
  }], settings);
  assertEquals(renderProfile(profile).includes("must be reviewed"), true);
});
