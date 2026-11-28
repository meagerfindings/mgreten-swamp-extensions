/** Explicit manual checkpoint reanchoring; not GPS, routing or traffic estimation. */
import { z } from "npm:zod@4";

const minutes = z.number().int().min(0).max(10080);
export const manualCheckInSchema = z.object({
  checkpoint: z.string().min(1).max(100),
  observedAt: z.iso.datetime({ offset: true }),
  delayMinutes: minutes.optional(),
  maxAgeMinutes: z.number().int().min(1).max(1440).optional(),
}).strict();
export type ManualCheckIn = z.infer<typeof manualCheckInSchema>;

type Route = {
  name: string;
  remainingFrom?: string;
  checkpoints: {
    name: string;
    lat: number;
    lon: number;
    offsetMinutes?: number;
    eta?: string;
  }[];
};
const routesSchema = z.array(
  z.object({
    name: z.string().min(1).max(100),
    remainingFrom: z.string().min(1).max(100).optional(),
    checkpoints: z.array(
      z.object({
        name: z.string().min(1).max(100),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        offsetMinutes: minutes,
      }).strict(),
    ).min(1).max(30),
  }).strict(),
).min(1).max(8);

/** Original offsets include planned stops; delay is applied once to each later estimate. */
export function reanchorRoutes(
  routes: Route[],
  checkIn: ManualCheckIn,
  now: () => Date = () => new Date(),
) {
  const args = manualCheckInSchema.parse(checkIn);
  const parsed = routesSchema.parse(routes);
  const observed = Date.parse(args.observedAt);
  const current = now().getTime();
  if (
    !Number.isFinite(current) || observed > current ||
    current - observed > (args.maxAgeMinutes ?? 60) * 60_000
  ) {
    throw new Error("Manual check-in is future-dated or too old");
  }
  if (
    parsed.reduce((n, route) => n + route.checkpoints.length, 0) > 30 ||
    new Set(parsed.map((route) => route.name)).size !== parsed.length
  ) {
    throw new Error("Invalid route count or duplicate route name");
  }
  let checkInCoordinates: string | undefined;
  return parsed.map((route) => {
    const names = route.checkpoints.map((point) => point.name);
    if (new Set(names).size !== names.length) {
      throw new Error(`Ambiguous checkpoint in ${route.name}`);
    }
    const index = names.indexOf(args.checkpoint);
    if (index < 0) {
      throw new Error(`Manual checkpoint missing from ${route.name}`);
    }
    for (let i = 1; i < route.checkpoints.length; i++) {
      if (
        route.checkpoints[i].offsetMinutes <
          route.checkpoints[i - 1].offsetMinutes
      ) throw new Error(`Nonmonotonic offsets in ${route.name}`);
    }
    const origin = route.checkpoints[index];
    const coords = JSON.stringify([origin.lat, origin.lon]);
    if (checkInCoordinates !== undefined && coords !== checkInCoordinates) {
      throw new Error("Manual checkpoint differs between routes");
    }
    checkInCoordinates = coords;
    return {
      name: route.name,
      remainingFrom: args.checkpoint,
      checkpoints: route.checkpoints.slice(index).map((point, i) => {
        const offsetMinutes = point.offsetMinutes - origin.offsetMinutes +
          (i === 0 ? 0 : (args.delayMinutes ?? 0));
        if (offsetMinutes > 10080) {
          throw new Error("Reanchored offset exceeds assessment limit");
        }
        return {
          name: point.name,
          lat: point.lat,
          lon: point.lon,
          offsetMinutes,
          eta: new Date(observed + offsetMinutes * 60_000).toISOString(),
        };
      }),
    };
  });
}
