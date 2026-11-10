import { assertEquals } from "jsr:@std/assert@1";
import { renderTourPage, tourPagePaths } from "./pr_tour_report.ts";
import { ReportSettingsSchema, type Tour } from "../models/pr_tour.ts";

Deno.test("renderTourPage embeds a diff containing </script> without closing its data tag", () => {
  const patch = '+<script>alert("hi")</script>\n+<!-- </SCRIPT> -->';
  const tour: Tour = {
    repo: "o/r",
    prNumber: 7,
    title: "Add <b>bold</b> banner",
    url: "https://github.com/o/r/pull/7",
    author: "a",
    baseRef: "main",
    headRef: "b",
    headSha: "0123456789abcdef",
    additions: 2,
    deletions: 0,
    builtAt: "2026-11-10T00:00:00Z",
    provider: "claude",
    model: "m",
    attempts: 1,
    summary: "s",
    stops: [{
      title: "t",
      narrative: "n",
      pieces: [{ hunkId: "h1", from: 1, to: 2 }],
      reviewFocus: [],
      risk: "low",
    }],
    skim: { pieces: [], reason: "" },
    hunks: [{
      id: "h1",
      path: "app/views/x.html.erb",
      status: "modified",
      header: "@@ -1,0 +1,2 @@",
      oldStart: 1,
      newStart: 1,
      patch,
      additions: 2,
      deletions: 0,
    }],
  };

  const html = renderTourPage(tour);
  const open = '<script type="application/json" id="tour-data">';
  const start = html.indexOf(open) + open.length;
  const data = JSON.parse(html.slice(start, html.indexOf("</script>", start)));
  assertEquals(data.hunks[0].patch, patch);
  assertEquals(
    html.includes("<title>Tour #7: Add &lt;b&gt;bold&lt;/b&gt; banner</title>"),
    true,
  );
});

const MINIMAL: Tour = {
  repo: "o/r",
  prNumber: 12,
  title: "t",
  url: "https://github.com/o/r/pull/12",
  author: "a",
  baseRef: "main",
  headRef: "b",
  headSha: "fedcba9876543210",
  additions: 0,
  deletions: 0,
  builtAt: "2026-11-10T00:00:00Z",
  provider: "claude",
  model: "m",
  attempts: 1,
  summary: "s",
  stops: [{
    title: "t",
    narrative: "n",
    pieces: [{ hunkId: "h1", from: 1, to: 0 }],
    reviewFocus: [],
    risk: "low",
  }],
  skim: { pieces: [], reason: "" },
  hunks: [{
    id: "h1",
    path: "logo.png",
    status: "binary",
    header: "",
    oldStart: 0,
    newStart: 0,
    patch: "",
    additions: 0,
    deletions: 0,
  }],
};

Deno.test("renderTourPage applies theme overrides per mode after the built-in theme, and the storage key", () => {
  const html = renderTourPage(MINIMAL, {
    themeStorageKey: "team:theme",
    theme: {
      dark: { accent: "#ff9e64" },
      light: { "--font-ui": "Inter, sans-serif" },
    },
  });
  const builtInLight = html.indexOf(
    ':root[data-theme="light"]{color-scheme:light;',
  );
  const darkOverride = html.indexOf(":root{--accent:#ff9e64}");
  const lightOverride = html.indexOf(
    ':root[data-theme="light"]{--font-ui:Inter, sans-serif}',
  );
  assertEquals(
    builtInLight > 0 && darkOverride > builtInLight &&
      lightOverride > darkOverride,
    true,
  );
  assertEquals(html.includes('localStorage.getItem("team:theme")'), true);
  assertEquals(html.includes("pr-tour:theme"), false);
});

Deno.test("ReportSettingsSchema rejects theme values that could break out of the style tag", () => {
  const result = ReportSettingsSchema.safeParse({
    theme: { dark: { accent: "red}</style><script>" } },
  });
  assertEquals(result.success, false);
});

Deno.test("tourPagePaths expands ~ and links the latest page under the base URL", () => {
  const home = Deno.env.get("HOME") ?? "";
  assertEquals(
    tourPagePaths({
      pagesDir: "~/tours/",
      pageBaseUrl: "http://localhost:8000/",
    }, MINIMAL),
    {
      dir: `${home}/tours`,
      versioned: `${home}/tours/12-fedcba987654.html`,
      latest: `${home}/tours/12.html`,
      url: "http://localhost:8000/12.html",
    },
  );
  assertEquals(
    tourPagePaths({ pagesDir: "/srv/t", pageBaseUrl: "" }, MINIMAL).url,
    "file:///srv/t/12.html",
  );
});
