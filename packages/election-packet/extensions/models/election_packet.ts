/** Evidence assembly only: no voter profiles, vote recommendations, network or filesystem access. */
import { z } from "npm:zod@4.1.12";

const Text = z.string().trim().min(1).max(1200).refine((s) =>
  !/[\r\n\0]/.test(s)
);
const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const SourceIds = z.array(Id).max(8);
const Kind = z.enum(["candidate", "measure", "judge"]);
const Fact = z.object({
  text: Text,
  status: z.enum(["documented", "allegation", "opinion", "unknown"]),
  sources: SourceIds,
}).strict();
const Source = z.object({
  id: Id,
  title: Text,
  url: z.url().refine(
    (s) => {
      const u = new URL(s);
      return u.protocol === "https:" && !u.username && !u.password &&
        !u.search &&
        !["localhost", "127.0.0.1", "::1"].includes(u.hostname) &&
        !u.hostname.endsWith(".local") && u.hostname !== "ampcode.com";
    },
    "Use a public HTTPS citation without credentials, query tokens or private attachments",
  ),
  kind: z.enum(["official", "campaign", "reporting", "advocacy", "opinion"]),
  accessed: z.iso.date(),
  historical: z.boolean(),
}).strict();
export const Ballot = z.object({
  electionDate: z.iso.date(),
  jurisdiction: Text,
  style: z.object({
    confirmed: z.boolean(),
    description: Text,
    sources: SourceIds,
  }).strict(),
  items: z.array(z.object({ id: Id, kind: Kind, label: Text }).strict()).min(1)
    .max(150),
}).strict();
const Base = {
  id: Id,
  reviewed: z.boolean(),
  summary: Fact,
};
const Candidate = z.object({
  ...Base,
  kind: z.literal("candidate"),
  findings: z.array(Fact).min(1).max(4),
}).strict();
const Measure = z.object({
  ...Base,
  kind: z.literal("measure"),
  yesMeans: Fact,
  noMeans: Fact,
  fiscal: Fact,
  positions: z.array(
    z.object({
      organization: Text,
      position: z.enum(["support", "oppose", "neutral", "not_found"]),
      evidence: Fact,
    }).strict(),
  ).max(8),
}).strict();
const Judge = z.object({
  ...Base,
  kind: z.literal("judge"),
  appointment: Fact,
  evaluation: Fact,
  cases: z.array(
    z.object({
      name: Text,
      role: z.enum(["trial_judge", "author", "joined", "dissent", "other"]),
      outcome: z.enum([
        "sentence",
        "bond",
        "new_trial",
        "resentencing",
        "partial_dismissal",
        "dismissal",
        "affirmed",
        "release_order",
        "other",
      ]),
      finding: Fact,
      limits: Fact,
    }).strict(),
  ).max(4),
  accountability: Fact,
}).strict();
export const Packet = z.object({
  version: z.literal(1),
  asOf: z.iso.date(),
  ballot: Ballot,
  sources: z.array(Source).max(500),
  subjects: z.array(z.discriminatedUnion("kind", [Candidate, Measure, Judge]))
    .max(150),
}).strict();
type Dossier = z.infer<typeof Packet>;
const Audit = z.object({
  ready: z.boolean(),
  issues: z.array(z.string()),
  unknowns: z.number().int(),
  itemCount: z.number().int(),
});
const Args = z.object({ packet: Packet }).strict();
type Context = {
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};
const pending = (): z.infer<typeof Fact> => ({
  text: "Not researched yet",
  status: "unknown",
  sources: [],
});

function audit(p: Dossier) {
  const issues: string[] = [];
  let unknowns = 0;
  const sources = new Map(p.sources.map((s) => [s.id, s]));
  const roster = new Map(p.ballot.items.map((s) => [s.id, s]));
  if (sources.size !== p.sources.length) issues.push("Duplicate source IDs");
  if (roster.size !== p.ballot.items.length) {
    issues.push("Duplicate ballot item IDs");
  }
  if (new Set(p.subjects.map((s) => s.id)).size !== p.subjects.length) {
    issues.push("Duplicate subject IDs");
  }
  const refs = (ids: string[], where: string) => {
    for (const id of ids) {
      if (!sources.has(id)) issues.push(`${where}: unknown source ${id}`);
    }
  };
  refs(p.ballot.style.sources, "Ballot style");
  if (!p.ballot.style.confirmed || !p.ballot.style.sources.length) {
    issues.push("Exact ballot style is unconfirmed or lacks a citation");
  }
  for (const s of p.sources) {
    if (s.accessed > p.asOf) {
      issues.push(`${s.id}: source accessed after packet as-of date`);
    }
    if (
      !s.historical &&
      Date.parse(p.asOf) - Date.parse(s.accessed) > 30 * 86400000
    ) {
      issues.push(
        `${s.id}: current source needs rechecking (over 30 days old)`,
      );
    }
  }
  const fact = (f: z.infer<typeof Fact>, where: string) => {
    refs(f.sources, where);
    if (f.text.split(/\s+/u).length > 55) {
      issues.push(`${where}: exceeds 55 words`);
    }
    if (f.status === "unknown") unknowns++;
    else if (!f.sources.length) issues.push(`${where}: citation required`);
    if (f.text === "Not researched yet") {
      issues.push(`${where}: research pending`);
    }
  };
  for (const item of p.ballot.items) {
    if (!p.subjects.some((s) => s.id === item.id)) {
      issues.push(`${item.id}: missing ballot item`);
    }
  }
  for (const s of p.subjects) {
    if (roster.get(s.id)?.kind !== s.kind) {
      issues.push(`${s.id}: not matched to ballot roster`);
    }
    if (!s.reviewed) issues.push(`${s.id}: review pending`);
    fact(s.summary, `${s.id} summary`);
    if (s.kind === "candidate") s.findings.forEach((f) => fact(f, s.id));
    if (s.kind === "measure") {
      for (const f of [s.yesMeans, s.noMeans, s.fiscal]) fact(f, s.id);
      for (const pos of s.positions) {
        fact(pos.evidence, `${s.id} ${pos.organization}`);
      }
    }
    if (s.kind === "judge") {
      for (const f of [s.appointment, s.evaluation, s.accountability]) {
        fact(f, s.id);
      }
      for (const c of s.cases) {
        fact(c.finding, `${s.id} ${c.name}`);
        fact(c.limits, `${s.id} ${c.name} limits`);
      }
    }
  }
  return {
    ready: !issues.length,
    issues,
    unknowns,
    itemCount: p.ballot.items.length,
  };
}

// Escape authored strings instead of accepting Markdown/HTML as executable formatting.
const md = (s: string) => s.replace(/[\\`*_{}\[\]<>()#!|~]/g, "\\$&");
const html = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function renderPacket(p: Dossier) {
  const result = audit(p);
  if (!result.ready) {
    throw new Error(`Packet is not ready:\n${result.issues.join("\n")}`);
  }
  const labels = new Map(p.ballot.items.map((s) => [s.id, s.label]));
  const m: string[] = [];
  const h: string[] = [];
  const heading = (text: string, level = 2) => {
    m.push(`${"#".repeat(level)} ${md(text)}\n`);
    h.push(`<h${level}>${html(text)}</h${level}>`);
  };
  const paragraph = (text: string) => {
    m.push(`${md(text)}\n`);
    h.push(`<p>${html(text)}</p>`);
  };
  const fm = (f: z.infer<typeof Fact>) =>
    `${md(f.status)}: ${md(f.text)} ${
      f.sources.map((s) => `[${md(s)}](#source-${s})`).join(" ")
    }`;
  const fh = (f: z.infer<typeof Fact>) =>
    `<strong>${html(f.status)}:</strong> ${html(f.text)}${
      f.sources.length ? "&nbsp;" : ""
    }${
      f.sources.map((s) => `<a href="#source-${s}">[${s}]</a>`).join("&nbsp;")
    }`;
  const table = (headers: string[], rows: { m: string[]; h: string[] }[]) => {
    m.push(
      `| ${headers.map(md).join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((r) => `| ${r.m.join(" | ")} |`),
      "",
    );
    h.push(
      `<table><thead><tr>${
        headers.map((s) => `<th>${html(s)}</th>`).join("")
      }</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.h.map((s) => `<td>${s}</td>`).join("")}</tr>`)
          .join("")
      }</tbody></table>`,
    );
  };
  heading(`${p.ballot.jurisdiction} — ${p.ballot.electionDate}`, 1);
  paragraph(
    `Research as of ${p.asOf}. ${result.itemCount} ballot entries; ${result.unknowns} explicitly unknown findings. Evidence review, not a voting recommendation or a record of votes.`,
  );
  paragraph(
    `Ballot style: ${p.ballot.style.description}. Sources: ${
      p.ballot.style.sources.join(", ")
    }.`,
  );
  // Preserve ballot order rather than sorting by a political score or by research completion.
  const ordered = p.ballot.items.map((item) =>
    p.subjects.find((s) => s.id === item.id)!
  );
  heading("Candidates");
  table(
    ["Office / candidate", "Evidence summary"],
    ordered.filter((s) => s.kind === "candidate").map((s) => ({
      m: [md(labels.get(s.id)!), fm(s.summary)],
      h: [html(labels.get(s.id)!), fh(s.summary)],
    })),
  );
  heading("Ballot measures");
  for (const s of ordered) {
    if (s.kind !== "measure") continue;
    heading(labels.get(s.id)!, 3);
    const rows = [["Summary", s.summary], ["Yes changes", s.yesMeans], [
      "No preserves / changes",
      s.noMeans,
    ], ["Fiscal / regulatory effects", s.fiscal]] as const;
    table(
      ["Question", "Finding"],
      rows.map(([label, f]) => ({ m: [label, fm(f)], h: [label, fh(f)] })),
    );
    for (const pos of s.positions) {
      m.push(
        `**${md(pos.organization)}: ${pos.position}** — ${fm(pos.evidence)}\n`,
      );
      h.push(
        `<p><strong>${html(pos.organization)}: ${pos.position}</strong> — ${
          fh(pos.evidence)
        }</p>`,
      );
    }
  }
  heading("Judicial retention overview");
  paragraph(
    "Appointments identify the appointing authority, not the judge's party. A new trial, resentencing or partial dismissal does not itself establish release or later offending. Assessments are labeled opinions, not disciplinary findings.",
  );
  table(
    ["Judge / court", "Appointment", "Evaluation", "Evidence / assessment"],
    ordered.filter((s) => s.kind === "judge").map((s) => ({
      m: [
        md(labels.get(s.id)!),
        fm(s.appointment),
        fm(s.evaluation),
        fm(s.summary),
      ],
      h: [
        html(labels.get(s.id)!),
        fh(s.appointment),
        fh(s.evaluation),
        fh(s.summary),
      ],
    })),
  );
  const conciseMarkdown = m.join("\n");
  const conciseHtml = h.join("\n");
  m.length = 0;
  h.length = 0;
  heading(`${p.ballot.jurisdiction} — evidence appendix`, 1);
  paragraph(
    `Election: ${p.ballot.electionDate}. Research as of ${p.asOf}. Read alongside the concise packet; these are sourced findings, not reported votes.`,
  );
  for (const s of ordered) {
    if (s.kind === "measure") continue;
    heading(labels.get(s.id)!, 3);
    const facts = s.kind === "candidate" ? s.findings : [s.accountability];
    for (const f of facts) {
      m.push(`- ${fm(f)}`);
      h.push(`<p>${fh(f)}</p>`);
    }
    if (s.kind === "judge") {
      for (const c of s.cases) {
        paragraph(
          `${c.name} — role: ${c.role.replaceAll("_", " ")}; remedy: ${
            c.outcome.replaceAll("_", " ")
          }`,
        );
        m.push(`${fm(c.finding)}\n\nLimits: ${fm(c.limits)}\n`);
        h.push(`<p>${fh(c.finding)}</p><p>Limits: ${fh(c.limits)}</p>`);
      }
    }
  }
  const sourceMarkdown = p.sources.map((s) =>
    `<a id="source-${s.id}"></a>\n- **${s.id}** — [${
      md(s.title)
    }](${s.url}); ${s.kind}; accessed ${s.accessed}${
      s.historical ? "; historical" : ""
    }.`
  ).join("\n");
  const sourceHtml = p.sources.map((s) =>
    `<p id="source-${s.id}"><strong>${s.id}</strong> — <a href="${
      html(s.url)
    }">${html(s.title)}</a>; ${s.kind}; accessed ${s.accessed}${
      s.historical ? "; historical" : ""
    }.</p>`
  ).join("\n");
  const page = (body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Election research</title><style>
@page{size:letter;margin:0.55in}
body{font:11pt/1.35 sans-serif;color:#111;max-width:1000px;margin:24px auto}
h1{font-size:19pt}h2{font-size:15pt}h3{font-size:12pt}
table{border-collapse:collapse;width:100%;font-size:9pt;table-layout:fixed}
th,td{border:1px solid #bbb;padding:6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
thead{display:table-header-group}tr{break-inside:avoid}h2,h3{break-after:avoid}
a{color:#174779}p{overflow-wrap:anywhere}@media print{body{margin:0;max-width:none}}
</style></head><body>${body}<h2>Sources</h2>${sourceHtml}</body></html>`;
  return {
    ...result,
    markdown: `${conciseMarkdown}\n## Sources\n\n${sourceMarkdown}\n`,
    html: page(conciseHtml),
    appendixMarkdown: `${m.join("\n")}\n## Sources\n\n${sourceMarkdown}\n`,
    appendixHtml: page(h.join("\n")),
  };
}

/** Reusable, politically neutral structured ballot research compiler. */
export const model = {
  type: "@mgreten/election-packet",
  version: "2026.11.02.1",
  globalArguments: z.object({}).strict(),
  resources: {
    draft: {
      description: "Unresearched ballot-bound dataset, without voter data",
      schema: Packet,
      lifetime: "30d",
      garbageCollection: 5,
    },
    audit: {
      description:
        "Coverage, citation, freshness and length checks; not verification of source truth",
      schema: Audit,
      lifetime: "30d",
      garbageCollection: 5,
    },
    document: {
      description:
        "Concise packet and evidence appendix; local output is not a public release",
      schema: Audit.extend({
        markdown: z.string(),
        html: z.string(),
        appendixMarkdown: z.string(),
        appendixHtml: z.string(),
      }),
      lifetime: "30d",
      garbageCollection: 5,
    },
  },
  methods: {
    prepare: {
      description:
        "Create an unresearched dataset from an explicitly supplied ballot roster; never infer districts",
      arguments: z.object({
        ballot: Ballot,
        asOf: z.iso.date(),
        sources: z.array(Source),
      }).strict(),
      execute: async (
        input: {
          ballot: z.infer<typeof Ballot>;
          asOf: string;
          sources: z.infer<typeof Source>[];
        },
        ctx: Context,
      ) => {
        const draft = Packet.parse({
          version: 1,
          ...input,
          subjects: input.ballot.items.map((item) => {
            const base = {
              id: item.id,
              kind: item.kind,
              reviewed: false,
              summary: pending(),
            };
            if (item.kind === "candidate") {
              return { ...base, findings: [pending()] };
            }
            if (item.kind === "measure") {
              return {
                ...base,
                yesMeans: pending(),
                noMeans: pending(),
                fiscal: pending(),
                positions: [],
              };
            }
            return {
              ...base,
              appointment: pending(),
              evaluation: pending(),
              accountability: pending(),
              cases: [],
            };
          }),
        });
        return {
          dataHandles: [await ctx.writeResource("draft", "draft", draft)],
        };
      },
    },
    audit: {
      description:
        "Find missing ballot entries, unchecked research, missing citations, stale sources and overlong summaries",
      arguments: Args,
      execute: async (input: z.infer<typeof Args>, ctx: Context) => ({
        dataHandles: [
          await ctx.writeResource(
            "audit",
            "audit",
            audit(Packet.parse(input.packet)),
          ),
        ],
      }),
    },
    render: {
      description:
        "Compile reviewed evidence into concise Markdown and printable HTML plus a separate detailed appendix; refuse unresolved audit issues",
      arguments: Args,
      execute: async (input: z.infer<typeof Args>, ctx: Context) => ({
        dataHandles: [
          await ctx.writeResource(
            "document",
            "document",
            renderPacket(Packet.parse(input.packet)),
          ),
        ],
      }),
    },
  },
};
