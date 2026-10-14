import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildPlan, markerFor, TripInputSchema } from "./trip-packing.ts";
import familyRoadTrip from "./fixtures/family-road-trip.json" with {
  type: "json",
};

Deno.test("five-day solo work trip calculates exact clothing quantities", () => {
  const plan = buildPlan({
    projectName: "CamJam Work Trip — Lincoln (Jul 28–Aug 1)",
    days: 5,
    travelMode: "plane",
    lodging: "hotel",
    activities: ["work", "casual"],
    travelers: 1,
    includesKids: false,
    includeWorkGear: true,
    international: false,
    homeOccupied: true,
    customItems: [],
  });
  const clothing = plan.categories.find((category) =>
    category.key === "clothing"
  );
  assertEquals(clothing?.items, [
    "5 work/casual shirts (wear 1; pack 4)",
    "6 pairs underwear (5 days + 1 spare)",
    "6 pairs socks (5 days + 1 spare)",
    "2 pairs work/casual pants (wear 1; pack 1)",
    "1 sleep outfit",
    "1 weather-appropriate layer",
    "Laundry bag",
  ]);
  assert(
    !plan.categories.some((category) => category.key === "beforeLeavingHouse"),
  );
});

Deno.test("preview remains deterministic for equivalent inputs", () => {
  const first = buildPlan(familyRoadTrip);
  const second = buildPlan(familyRoadTrip);
  assertEquals(first, second);
  assertEquals(first.marker, markerFor(TripInputSchema.parse(familyRoadTrip)));
  assert(first.categories.some((category) => category.key === "kids"));
  assert(first.categories.some((category) => category.key === "vehicle"));
});

Deno.test("invalid trip input fails before planning", () => {
  let threw = false;
  try {
    buildPlan({ ...familyRoadTrip, days: 0 });
  } catch {
    threw = true;
  }
  assert(threw);
});
