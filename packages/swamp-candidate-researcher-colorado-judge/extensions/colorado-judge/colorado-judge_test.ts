function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

declare const Deno: {
  readTextFile(path: URL): Promise<string>;
  test(name: string, fn: () => void | Promise<void>): void;
};

const manifest = await Deno.readTextFile(new URL("./manifest.yaml", import.meta.url));
const readme = await Deno.readTextFile(new URL("./README.md", import.meta.url));
const entrypoint = await Deno.readTextFile(new URL("./colorado-judge.ts", import.meta.url));

const forbidden = [
  "Mat Greten",
  "mgreten@gmail.com",
  "TODOIST_API_TOKEN",
  "SWAMP_API_KEY",
];

Deno.test("Colorado judge package uses the public collective", () => {
  assert(manifest.includes('name: "@mgreten/swamp-candidate-researcher-colorado-judge"'), "package name should use @mgreten collective");
  assert(!forbidden.some((value) => manifest.includes(value)), "manifest should not contain personal data or secrets");
});

Deno.test("Colorado judge entrypoint re-exports the canonical model", () => {
  assert(entrypoint.includes("../../models/colorado/judge-research-colorado.ts"), "entrypoint should point at the canonical root model");
});

Deno.test("Colorado judge README stays free of personal data", () => {
  const hits = forbidden.filter((value) => readme.includes(value));
  assert(hits.length === 0, `README contains forbidden content: ${hits.join(", ")}`);
});
