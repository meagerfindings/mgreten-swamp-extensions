import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  mergeEvents,
  type NormalizedSafetyEvent,
  reconcileEvents,
  renderDigest,
  safeDisplayHeadline,
  type WatchState,
} from "./model.ts";

const ACTIVE_CLOSURE: NormalizedSafetyEvent = {
  source: "cotrip",
  sourceEventId: "closure-17",
  sourceRevision: "2026-07-12T16:00:00Z",
  category: "road-closure",
  severity: "major",
  status: "active",
  headline: "Road closure near monitored area",
  effectiveAt: "2026-07-12T16:00:00Z",
  expiresAt: null,
  anchorLabels: ["home"],
  distanceBucket: "1-5 mi",
};

const EMPTY_STATE: WatchState = { events: {}, sources: {}, pending: null };

Deno.test("reconcileEvents emits a new event only once for an unchanged provider revision", async () => {
  const first = await reconcileEvents(EMPTY_STATE, [ACTIVE_CLOSURE]);
  assertEquals(first.changes.length, 1);
  assertEquals(first.changes[0].action, "new");

  const repeated = await reconcileEvents(first.state, [ACTIVE_CLOSURE]);
  assertEquals(repeated.changes, []);
});

Deno.test("reconcileEvents emits an update only for a material provider revision", async () => {
  const first = await reconcileEvents(EMPTY_STATE, [ACTIVE_CLOSURE]);
  const updated = await reconcileEvents(first.state, [{
    ...ACTIVE_CLOSURE,
    sourceRevision: "2026-07-12T17:00:00Z",
    severity: "extreme",
  }]);

  assertEquals(updated.changes.length, 1);
  assertEquals(updated.changes[0].action, "escalated");
});

Deno.test("reconcileEvents clears only after two authoritative misses", async () => {
  const first = await reconcileEvents(EMPTY_STATE, [ACTIVE_CLOSURE]);
  const firstMiss = await reconcileEvents(first.state, [], {
    authoritativeSources: ["cotrip"],
  });
  assertEquals(firstMiss.changes, []);

  const secondMiss = await reconcileEvents(firstMiss.state, [], {
    authoritativeSources: ["cotrip"],
  });
  assertEquals(secondMiss.changes.length, 1);
  assertEquals(secondMiss.changes[0].action, "cleared");
});

Deno.test("renderDigest omits coordinates and exact distance", () => {
  const digest = renderDigest([{
    action: "new",
    event: ACTIVE_CLOSURE,
  }]);

  assertStringIncludes(digest, "Official road closure");
  assertStringIncludes(digest, "near home");
  assertEquals(digest.includes("40.1448"), false);
  assertEquals(digest.includes("-104.8876"), false);
  assertEquals(digest.includes("1.337"), false);
});

Deno.test("renderDigest includes a sanitized NWS description", () => {
  const digest = renderDigest([{
    action: "new",
    event: {
      ...ACTIVE_CLOSURE,
      source: "nws",
      sourceEventId: "nws-description-alert",
      category: "weather",
      description:
        "Heavy snow expected at 40.1448, -104.8876 from 9 PM through noon tomorrow.",
    },
  }]);

  assertStringIncludes(
    digest,
    "Heavy snow expected at [coordinates] from 9 PM through noon tomorrow.",
  );
  assertEquals(digest.includes("40.1448"), false);
  assertEquals(digest.includes("-104.8876"), false);
});

Deno.test("mergeEvents combines one official event that applies to multiple anchors", async () => {
  const merged = await mergeEvents([
    ACTIVE_CLOSURE,
    {
      ...ACTIVE_CLOSURE,
      anchorLabels: ["phone-1"],
      distanceBucket: "under 1 mi",
    },
  ]);

  assertEquals(merged.length, 1);
  assertEquals(merged[0].anchorLabels, ["home", "phone-1"]);
  assertEquals(merged[0].distanceBucket, "under 1 mi");
});

Deno.test("renderDigest strips provider URLs and coordinate pairs from provider text", () => {
  const digest = renderDigest([{
    action: "new",
    event: {
      ...ACTIVE_CLOSURE,
      headline:
        "Road closure https://example.invalid/event at 40.1448, -104.8876",
    },
  }]);

  assertStringIncludes(digest, "Official road closure");
  assertEquals(digest.includes("https://"), false);
  assertEquals(digest.includes("40.1448"), false);
  assertEquals(digest.includes("-104.8876"), false);
});

Deno.test("safeDisplayHeadline never persists provider-provided locality text", () => {
  assertEquals(
    safeDisplayHeadline(
      "cotrip",
      "road-closure",
      "I-25 closed near a private address",
    ),
    "Official road closure",
  );
});

Deno.test("reconcileEvents stores category-level text rather than provider headlines", async () => {
  const result = await reconcileEvents(EMPTY_STATE, [{
    ...ACTIVE_CLOSURE,
    headline: "Private roadway detail at 40.1234, -104.1234",
  }], { authoritativeSources: ["cotrip"] });

  const stored = Object.values(result.state.events)[0];
  assertEquals(stored.headline, "Official road closure");
  assertEquals(stored.headline.includes("40.1234"), false);
});

Deno.test("reconcileEvents re-redacts legacy provider headlines during updates", async () => {
  const first = await reconcileEvents(EMPTY_STATE, [{
    ...ACTIVE_CLOSURE,
    headline: "Old provider headline near a private place",
  }], { authoritativeSources: ["cotrip"] });
  const next = await reconcileEvents(first.state, [{
    ...ACTIVE_CLOSURE,
    sourceRevision: "revision-2",
    headline: "New provider headline near a private place",
  }], { authoritativeSources: ["cotrip"] });

  assertEquals(
    Object.values(next.state.events)[0].headline,
    "Official road closure",
  );
});

Deno.test("mergeEvents keeps distinct canonical NWS alert IDs separate", async () => {
  const merged = await mergeEvents([
    {
      ...ACTIVE_CLOSURE,
      source: "nws",
      sourceEventId: "first",
      category: "air-quality",
      headline: "Air Quality Alert",
    },
    {
      ...ACTIVE_CLOSURE,
      source: "nws",
      sourceEventId: "second",
      category: "air-quality",
      headline: "Air Quality Alert",
      anchorLabels: ["phone-1"],
    },
  ]);

  assertEquals(merged.length, 2);
});

Deno.test("NWS expiry does not clear an alert while its canonical ID remains active", async () => {
  const activeNwsAlert: NormalizedSafetyEvent = {
    ...ACTIVE_CLOSURE,
    source: "nws",
    sourceEventId: "nws-canonical-alert-1",
    category: "weather",
    expiresAt: "2026-07-12T16:01:00Z",
  };
  const first = await reconcileEvents(EMPTY_STATE, [activeNwsAlert], {
    authoritativeSources: ["nws"],
    now: "2026-07-12T16:00:00Z",
  });
  const stillActiveAfterExpiry = await reconcileEvents(first.state, [
    activeNwsAlert,
  ], {
    authoritativeSources: ["nws"],
    now: "2026-07-12T17:00:00Z",
  });
  assertEquals(stillActiveAfterExpiry.changes, []);
  assertEquals(Object.keys(stillActiveAfterExpiry.state.events).length, 1);
  const firstOmission = await reconcileEvents(
    stillActiveAfterExpiry.state,
    [],
    {
      authoritativeSources: ["nws"],
    },
  );
  assertEquals(firstOmission.changes, []);
  const secondOmission = await reconcileEvents(firstOmission.state, [], {
    authoritativeSources: ["nws"],
  });
  assertEquals(secondOmission.changes[0].action, "cleared");
});
