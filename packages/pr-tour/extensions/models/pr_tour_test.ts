import { assertEquals } from "jsr:@std/assert@1";
import {
  GlobalArgsSchema,
  parseUnifiedDiff,
  pieceLines,
  toAgentTour,
  validateTourCoverage,
} from "./pr_tour.ts";

const DIFF = `diff --git a/app/models/showcase.rb b/app/models/showcase.rb
index 1111111..2222222 100644
--- a/app/models/showcase.rb
+++ b/app/models/showcase.rb
@@ -1,4 +1,5 @@ class Showcase
   has_many :media
+  has_many :videos
   def title
-    name
+    name.strip
@@ -40,3 +41,4 @@ def publish
   validate!
+++ counter
 end
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/logo.png differ
diff --git a/lib/old_name.rb b/lib/new_name.rb
similarity index 100%
rename from lib/old_name.rb
rename to lib/new_name.rb
diff --git a/spec/legacy_spec.rb b/spec/legacy_spec.rb
deleted file mode 100644
index 4444444..0000000
--- a/spec/legacy_spec.rb
+++ /dev/null
@@ -1,2 +0,0 @@
-it "works" do
-end
`;

Deno.test("parseUnifiedDiff splits hunks and keeps files without text hunks", () => {
  const hunks = parseUnifiedDiff(DIFF);
  assertEquals(
    hunks.map((
      h,
    ) => [
      h.id,
      h.path,
      h.status,
      h.oldStart,
      h.newStart,
      h.additions,
      h.deletions,
    ]),
    [
      ["h1", "app/models/showcase.rb", "modified", 1, 1, 2, 1],
      // "+++ counter" inside a hunk is an added line, not a file header.
      ["h2", "app/models/showcase.rb", "modified", 40, 41, 1, 0],
      ["h3", "logo.png", "binary", 0, 0, 0, 0],
      ["h4", "lib/new_name.rb", "renamed", 0, 0, 0, 0],
      ["h5", "spec/legacy_spec.rb", "deleted", 1, 0, 0, 2],
    ],
  );
  assertEquals(hunks[3].oldPath, "lib/old_name.rb");
  assertEquals(hunks[1].patch, "   validate!\n+++ counter\n end");
});

Deno.test("pieceLines numbers a slice from where it starts in the hunk, not from the hunk start", () => {
  const [h1] = parseUnifiedDiff(DIFF);
  // h1 lines: 1 ctx, 2 add, 3 ctx, 4 del, 5 add. Old side starts at 1, new side at 1.
  assertEquals(
    pieceLines(h1, 3, 5).map((l) => [l.kind, l.oldLine, l.newLine]),
    [["ctx", 2, 3], ["del", 3, null], ["add", null, 4]],
  );
});

const COUNTS = { h1: 5, h2: 3, h3: 0 };
const stop = (pieces: unknown[], reviewFocus: unknown[] = []) => ({
  title: "t",
  narrative: "n",
  pieces,
  reviewFocus,
  risk: "low",
});

Deno.test("validateTourCoverage accepts one hunk split across stops and a whole-hunk piece", () => {
  const tour = toAgentTour({
    stops: [
      stop([{ hunk: "h1", lines: "3-5" }, { hunk: "h2" }], [{
        piece: 2,
        note: "x",
      }]),
      stop([{ hunk: "h1", lines: "1-2" }]),
    ],
    skim: { pieces: ["h3"], reason: "" },
  }, COUNTS);
  assertEquals(tour.stops[0].pieces[1], { hunkId: "h2", from: 1, to: 3 });
  assertEquals(validateTourCoverage(COUNTS, tour), []);
});

Deno.test("validateTourCoverage reports gaps, overlaps, bad ranges, unknown hunks and bad focus", () => {
  const tour = toAgentTour({
    stops: [
      stop([{ hunk: "h1", lines: "1-3" }, { hunk: "h9" }], [{
        piece: 3,
        note: "x",
      }]),
      stop([{ hunk: "h1", lines: "3" }, { hunk: "h2", lines: "2-4" }, {
        hunk: "h3",
        lines: "1-2",
      }]),
      stop([]),
    ],
    skim: { pieces: [], reason: "" },
  }, COUNTS);
  assertEquals(validateTourCoverage(COUNTS, tour), [
    "stop 1 lists h9, which is not a hunk in this diff.",
    "stop 2 has h2 lines 2-4, outside its lines 1-3.",
    "stop 2 gives lines for h3, which has no lines; place it whole.",
    "stop 3 has no pieces.",
    "stop 1 has a reviewFocus on piece 3, but the stop has 2 pieces.",
    "h1 lines 3-3 appear in both stop 1 and stop 2.",
    "h1 lines 4-5 are not placed anywhere.",
    "These hunks are not placed anywhere: h2, h3.",
  ]);
});

Deno.test("GlobalArgsSchema refuses a repoSlug or gitRemote that git or gh would read as an option", () => {
  const base = { repoSlug: "octo-org/octo-repo", repoPath: "/r" };
  assertEquals(GlobalArgsSchema.safeParse(base).success, true);
  assertEquals(
    GlobalArgsSchema.safeParse({ ...base, gitRemote: "upstream" }).success,
    true,
  );
  assertEquals(
    GlobalArgsSchema.safeParse({
      ...base,
      gitRemote: "--upload-pack=touch /tmp/x",
    }).success,
    false,
  );
  assertEquals(
    GlobalArgsSchema.safeParse({ ...base, repoSlug: "--repo=x/y" }).success,
    false,
  );
  assertEquals(
    GlobalArgsSchema.safeParse({ ...base, repoSlug: "octo-repo" }).success,
    false,
  );
});
