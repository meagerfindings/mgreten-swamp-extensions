import { assertEquals } from "jsr:@std/assert@1";
import { rankExtension, renderReport } from "./model.ts";

const settings = {
  interests: ["homelab", "docker", "monitoring"],
  excludeTerms: ["aws", "gcp"],
  freshnessDays: 14,
  maxResults: 5,
};
const now = new Date("2026-07-18T12:00:00.000Z");

Deno.test("ranks a fresh, verified homelab extension", () => {
  const candidate = rankExtension({
    name: "@example/docker-health",
    description: "Tracks Docker service health for a homelab monitoring dashboard.",
    repository: "https://example.com/docker-health",
    repositoryVerified: true,
    createdAt: "2026-07-16T12:00:00.000Z",
    labels: ["homelab", "docker", "monitoring"],
    contentTypes: ["models"],
  }, settings, now);
  assertEquals(candidate?.freshness, "new");
  assertEquals(candidate?.score, 11);
});

Deno.test("excludes configured cloud-provider noise", () => {
  const candidate = rankExtension({
    name: "@example/aws-monitor",
    description: "AWS monitoring for homelab-like operations.",
    createdAt: "2026-07-17T12:00:00.000Z",
    labels: ["homelab"],
    contentTypes: ["models"],
  }, settings, now);
  assertEquals(candidate, null);
});

Deno.test("reports caveats for older candidates without a source", () => {
  const candidate = rankExtension({
    name: "@example/old-monitor",
    description: "Monitor.",
    createdAt: "2026-05-01T12:00:00.000Z",
    labels: ["homelab"],
    contentTypes: [],
  }, settings, now);
  assertEquals(candidate?.freshness, "older");
  assertEquals(candidate?.caveats.includes("No public repository URL was supplied"), true);
  assertEquals(candidate?.caveats.includes("Short description; inspect source before installing"), true);
});

Deno.test("renders a no-candidate report", () => {
  const markdown = renderReport([], 8, settings, now);
  assertEquals(markdown.includes("No candidates met"), true);
});
