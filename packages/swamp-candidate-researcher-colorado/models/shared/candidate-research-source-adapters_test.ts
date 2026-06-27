import { adaptSourcePacket } from "./candidate-research-source-adapters.ts";

declare const Deno: {
  test(name: string, fn: () => void | Promise<void>): void;
};

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("adaptSourcePacket enriches Ballotpedia pages", () => {
  const result = adaptSourcePacket({
    sourceName: "Ballotpedia",
    url: "https://ballotpedia.org/Example_Candidate",
    body: `
      <html>
        <head>
          <title>Example Candidate - Ballotpedia</title>
        </head>
        <body>
          <p>Candidate profile for a county commissioner race.</p>
        </body>
      </html>
    `,
  });

  assert(result.title === "Example Candidate - Ballotpedia", `unexpected title: ${result.title ?? "<missing>"}`);
  assert(result.excerpt?.includes("Candidate profile"), `unexpected excerpt: ${result.excerpt ?? "<missing>"}`);
  assert(result.notes?.includes("Ballotpedia"), `unexpected notes: ${result.notes ?? "<missing>"}`);
});

Deno.test("adaptSourcePacket enriches Colorado judicial pages", () => {
  const result = adaptSourcePacket({
    sourceName: "Colorado Judicial Performance",
    url: "https://judicialperformance.colorado.gov/judge/example",
    body: `
      <html>
        <head>
          <title>Judge Example</title>
        </head>
        <body>
          <p>Retention recommendation and performance evaluation are available.</p>
        </body>
      </html>
    `,
  });

  assert(result.excerpt?.includes("Retention recommendation"), `unexpected excerpt: ${result.excerpt ?? "<missing>"}`);
  assert(result.notes?.includes("judicial"), `unexpected notes: ${result.notes ?? "<missing>"}`);
});

Deno.test("adaptSourcePacket falls back to generic extraction for unknown pages", () => {
  const result = adaptSourcePacket({
    sourceName: "News Article",
    url: "https://example.com/article",
    body: "Simple plain text article body about a candidate and their record.",
  });

  assert(result.excerpt?.includes("candidate"), `unexpected excerpt: ${result.excerpt ?? "<missing>"}`);
  assert(result.notes?.includes("generic HTML/text enrichment"), `unexpected notes: ${result.notes ?? "<missing>"}`);
});
