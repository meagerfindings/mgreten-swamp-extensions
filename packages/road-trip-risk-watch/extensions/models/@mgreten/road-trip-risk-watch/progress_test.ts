import { reanchorRoutes } from "./progress.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const now = () => new Date("2026-11-28T10:05:00Z");
const checkIn = {
  checkpoint: "Middle",
  observedAt: "2026-11-28T10:00:00Z",
  maxAgeMinutes: 10,
  delayMinutes: 15,
};
const routes = [
  {
    name: "A",
    checkpoints: [{ name: "Origin", lat: 1, lon: 2, offsetMinutes: 0 }, {
      name: "Middle",
      lat: 2,
      lon: 3,
      offsetMinutes: 60,
    }, { name: "Finish A", lat: 3, lon: 4, offsetMinutes: 180 }],
  },
  {
    name: "B",
    checkpoints: [{ name: "Origin", lat: 1, lon: 2, offsetMinutes: 0 }, {
      name: "Middle",
      lat: 2,
      lon: 3,
      offsetMinutes: 40,
    }, { name: "Finish B", lat: 4, lon: 5, offsetMinutes: 220 }],
  },
];
Deno.test("rebases asymmetric alternatives from a shared manual check-in", () => {
  const result = reanchorRoutes(routes, checkIn, now);
  assert(
    result[0].remainingFrom === "Middle" &&
      result[0].checkpoints[0].eta === "2026-11-28T10:00:00.000Z",
    "check-in wrong",
  );
  assert(
    result[0].checkpoints[1].eta === "2026-11-28T12:15:00.000Z",
    "route A time wrong",
  );
  assert(
    result[1].checkpoints[1].eta === "2026-11-28T13:15:00.000Z",
    "route B time wrong",
  );
  assert(
    routes[0].checkpoints.length === 3 &&
      routes[0].checkpoints[1].offsetMinutes === 60,
    "input mutated",
  );
  const noDelay = reanchorRoutes(routes, {
    checkpoint: "Middle",
    observedAt: checkIn.observedAt,
  }, now);
  assert(
    noDelay[0].checkpoints[1].offsetMinutes === 120 &&
      noDelay[0].checkpoints[1].eta === "2026-11-28T12:00:00.000Z",
    "default timing wrong",
  );
});
Deno.test("rejects stale, future, ambiguous, missing, mismatched and invalid timing", () => {
  const cases: [Parameters<typeof reanchorRoutes>[0], typeof checkIn][] = [
    [routes, { ...checkIn, observedAt: "2026-11-28T09:54:59Z" }],
    [routes, { ...checkIn, observedAt: "2026-11-28T10:05:01Z" }],
    [routes, { ...checkIn, checkpoint: "Missing" }],
    [[routes[0], {
      ...routes[1],
      checkpoints: [...routes[1].checkpoints, routes[1].checkpoints[1]],
    }], checkIn],
    [[routes[0], {
      ...routes[1],
      checkpoints: routes[1].checkpoints.map((p) =>
        p.name === "Middle" ? { ...p, lat: 20 } : p
      ),
    }], checkIn],
    [[{
      ...routes[0],
      checkpoints: [
        { ...routes[0].checkpoints[0], offsetMinutes: 61 },
        ...routes[0].checkpoints.slice(1),
      ],
    }], checkIn],
    [[{
      ...routes[0],
      checkpoints: [{
        ...routes[0].checkpoints[0],
        eta: "2026-11-28T10:00:00Z",
      }, ...routes[0].checkpoints.slice(1)],
    }], checkIn],
  ];
  for (const [r, c] of cases) {
    let rejected = false;
    try {
      reanchorRoutes(r, c, now);
    } catch {
      rejected = true;
    }
    assert(rejected, "invalid input accepted");
  }
});
