function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

declare const Deno: {
  readTextFile(path: URL): Promise<string>;
  test(name: string, fn: () => void | Promise<void>): void;
};

const forbiddenPersonal = [
  "Mat Greten",
  "mgreten@gmail.com",
  "TODOIST_API_TOKEN",
  "SWAMP_API_KEY",
];

const forbiddenPerspective = [
  "conservative",
  "progressive",
  "republican",
  "democrat",
  "maga",
  "pro-life",
  "pro-choice",
  "right-wing",
  "left-wing",
];

const publicTextFiles = [
  new URL("../../README.md", import.meta.url),
  new URL("../../docs/repo-shape.md", import.meta.url),
  new URL("../../examples/config.sample.yaml", import.meta.url),
  new URL("../../examples/colorado-candidate.sample.yaml", import.meta.url),
  new URL("../../examples/federal-candidate.sample.yaml", import.meta.url),
  new URL("./candidate-research-shared.ts", import.meta.url),
  new URL("./candidate-research-core.ts", import.meta.url),
  new URL("./candidate-research-source-packs.ts", import.meta.url),
  new URL("./candidate-research-source-adapters.ts", import.meta.url),
];

async function readCombinedText(): Promise<string> {
  const chunks = await Promise.all(publicTextFiles.map((file) => Deno.readTextFile(file)));
  return chunks.join("\n\n");
}

Deno.test("public repo stays free of personal identifiers", async () => {
  const combined = await readCombinedText();
  const hits = forbiddenPersonal.filter((value) => combined.includes(value));
  assert(hits.length === 0, `public text contains personal identifiers: ${hits.join(", ")}`);
});

Deno.test("public repo stays free of private political perspective markers", async () => {
  const combined = await readCombinedText();
  const hits = forbiddenPerspective.filter((value) => combined.includes(value));
  assert(hits.length === 0, `public text contains perspective markers: ${hits.join(", ")}`);
});
