/**
 * Tests for the grist model. The model calls global fetch with no injection
 * seam, so each test stubs globalThis.fetch with a recorder that returns
 * synthetic JSON and restores the real fetch in a finally block. No network.
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./grist.ts";

type Req = { method: string; url: string; headers: Record<string, string>; body?: unknown };
type Write = { spec: string; name: string; data: Record<string, unknown> };
type Reply = { status?: number; json?: unknown; text?: string };

const GLOBALS = {
  gristBaseUrl: "https://grist.example.com/o/team/",
  gristDocId: "doc123",
  gristApiToken: "test-token-not-real",
};
const DOC = "https://grist.example.com/api/docs/doc123";

async function withFakeFetch<T>(
  reply: (req: Req) => Reply,
  fn: (reqs: Req[]) => Promise<T>,
): Promise<T> {
  const reqs: Req[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const req: Req = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    reqs.push(req);
    const r = reply(req);
    const status = r.status ?? 200;
    const body = r.text ?? JSON.stringify(r.json ?? {});
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  try {
    return await fn(reqs);
  } finally {
    globalThis.fetch = original;
  }
}

function makeContext() {
  const writes: Write[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(GLOBALS),
    logger: { info: () => {} },
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, writes };
}

Deno.test("global args require a URL, doc id and token", () => {
  assertEquals(model.globalArguments.safeParse(GLOBALS).success, true);
  assertEquals(model.globalArguments.safeParse({ ...GLOBALS, gristBaseUrl: "not a url" }).success, false);
  const { gristApiToken: _t, ...noToken } = GLOBALS;
  assertEquals(model.globalArguments.safeParse(noToken).success, false);
});

Deno.test("deleteRecords args require a non-empty list of positive integer ids", () => {
  const schema = model.methods.deleteRecords.arguments;
  assertEquals(schema.parse({ tableId: "T", recordIds: [1] }), {
    tableId: "T",
    recordIds: [1],
    dryRun: false,
  });
  for (const recordIds of [[], [0], [-1], [1.5]]) {
    assertEquals(schema.safeParse({ tableId: "T", recordIds }).success, false, String(recordIds));
  }
  assertEquals(schema.safeParse({ tableId: "", recordIds: [1] }).success, false);
  assertEquals(model.methods.getRecords.arguments.safeParse({ tableId: "T", limit: 2.5 }).success, false);
});

Deno.test("checkApi strips /o/<org> from the base URL and sends bearer auth", async () => {
  await withFakeFetch(() => ({ json: { id: "doc123", name: "Example Doc" } }), async (reqs) => {
    const { context, writes } = makeContext();
    const result = await model.methods.checkApi.execute({}, context);
    assertEquals(reqs.length, 1);
    assertEquals(reqs[0].method, "GET");
    assertEquals(reqs[0].url, DOC);
    assertEquals(reqs[0].headers.Authorization, "Bearer test-token-not-real");
    assertEquals(reqs[0].body, undefined);
    assertEquals(writes[0].spec, "apiStatus");
    assertEquals(result.dataHandles, [{ name: "api-status" }]);
    const { timestamp: _ts, ...rest } = writes[0].data;
    assertEquals(rest, { docId: "doc123", docName: "Example Doc", reachable: true });
    assertEquals(model.resources.apiStatus.schema.safeParse(writes[0].data).success, true);
  });
});

Deno.test("listTables and getColumns map the API payloads", async () => {
  const reply = (req: Req): Reply =>
    req.url.endsWith("/columns")
      ? {
        json: {
          columns: [
            { id: "Name", fields: { type: "Text", label: "Full name" } },
            { id: "Qty", fields: {} },
          ],
        },
      }
      : { json: { tables: [{ id: "Orders" }, { id: "Items" }] } };
  await withFakeFetch(reply, async (reqs) => {
    const tables = makeContext();
    await model.methods.listTables.execute({}, tables.context);
    assertEquals(reqs[0].url, `${DOC}/tables`);
    assertEquals(tables.writes[0].data.tables, ["Orders", "Items"]);
    assertEquals(tables.writes[0].data.count, 2);

    const cols = makeContext();
    await model.methods.getColumns.execute({ tableId: "Orders" }, cols.context);
    assertEquals(reqs[1].url, `${DOC}/tables/Orders/columns`);
    assertEquals(cols.writes[0].name, "column-list-Orders");
    assertEquals(cols.writes[0].data.columns, [
      { id: "Name", type: "Text", label: "Full name" },
      { id: "Qty", type: "", label: "Qty" }, // label falls back to id
    ]);
    assertEquals(model.resources.columnList.schema.safeParse(cols.writes[0].data).success, true);
  });
});

Deno.test("getRecords encodes filter and limit only when provided", async () => {
  const records = [{ id: 1, fields: { Status: "open" } }];
  await withFakeFetch(() => ({ json: { records } }), async (reqs) => {
    const a = makeContext();
    await model.methods.getRecords.execute(
      { tableId: "Orders", filter: { Status: ["open"] }, limit: 5 },
      a.context,
    );
    const url = new URL(reqs[0].url);
    assertEquals(url.pathname, "/api/docs/doc123/tables/Orders/records");
    assertEquals(url.searchParams.get("filter"), '{"Status":["open"]}');
    assertEquals(url.searchParams.get("limit"), "5");
    assertEquals(a.writes[0].data.records, records);
    assertEquals(a.writes[0].data.count, 1);

    await model.methods.getRecords.execute({ tableId: "Orders", filter: {} }, makeContext().context);
    assertEquals(reqs[1].url, `${DOC}/tables/Orders/records`);
  });
});

Deno.test("addRecords wraps fields and returns new row ids; dryRun sends nothing", async () => {
  await withFakeFetch(() => ({ json: { records: [{ id: 7 }, { id: 8 }] } }), async (reqs) => {
    const live = makeContext();
    await model.methods.addRecords.execute(
      { tableId: "Orders", records: [{ Qty: 1 }, { Qty: 2 }], dryRun: false },
      live.context,
    );
    assertEquals(reqs[0].method, "POST");
    assertEquals(reqs[0].body, { records: [{ fields: { Qty: 1 } }, { fields: { Qty: 2 } }] });
    assertEquals(live.writes[0].data.rowIds, [7, 8]);
    assertEquals(live.writes[0].data.dryRun, false);

    const dry = makeContext();
    await model.methods.addRecords.execute(
      { tableId: "Orders", records: [{ Qty: 1 }, { Qty: 2 }, { Qty: 3 }], dryRun: true },
      dry.context,
    );
    assertEquals(reqs.length, 1);
    assertEquals(dry.writes[0].data.rowIds, []);
    assertEquals(dry.writes[0].data.count, 3);
  });
});

Deno.test("mutating methods hit the right endpoints with the right bodies", async () => {
  await withFakeFetch(() => ({ json: {} }), async (reqs) => {
    const cols = [{ id: "Name", label: "Name", type: "Text" }];
    const ctx = () => makeContext().context;
    await model.methods.updateRecords.execute(
      { tableId: "T", records: [{ id: 3, fields: { A: 1 } }], dryRun: false },
      ctx(),
    );
    await model.methods.createTable.execute({ tableId: "T", columns: cols, dryRun: false }, ctx());
    await model.methods.addColumns.execute({ tableId: "T", columns: cols, dryRun: false }, ctx());
    await model.methods.deleteRecords.execute({ tableId: "T", recordIds: [4, 5], dryRun: false }, ctx());
    await model.methods.dropTable.execute({ tableId: "T", dryRun: false }, ctx());

    const colBody = [{ id: "Name", fields: { label: "Name", type: "Text" } }];
    assertEquals(reqs.map((r) => [r.method, r.url.slice(DOC.length), r.body]), [
      ["PATCH", "/tables/T/records", { records: [{ id: 3, fields: { A: 1 } }] }],
      ["POST", "/tables", { tables: [{ id: "T", columns: colBody }] }],
      ["POST", "/tables/T/columns", { columns: colBody }],
      ["POST", "/tables/T/data/delete", [4, 5]],
      ["POST", "/apply", [["RemoveTable", "T"]]],
    ]);
  });
});

Deno.test("destructive methods in dryRun make no requests and report not dropped", async () => {
  await withFakeFetch(() => ({ json: {} }), async (reqs) => {
    const drop = makeContext();
    await model.methods.dropTable.execute({ tableId: "T", dryRun: true }, drop.context);
    const del = makeContext();
    await model.methods.deleteRecords.execute({ tableId: "T", recordIds: [9], dryRun: true }, del.context);
    assertEquals(reqs.length, 0);
    assertEquals([drop.writes[0].data.dropped, drop.writes[0].data.dryRun], [false, true]);
    assertEquals(drop.writes[0].name, "table-drop-T");
    assertEquals([del.writes[0].data.deletedIds, del.writes[0].data.count], [[9], 1]);
  });
});

Deno.test("non-2xx responses throw with method, path, status and body; nothing written", async () => {
  await withFakeFetch(() => ({ status: 403, text: "forbidden" }), async () => {
    const { context, writes } = makeContext();
    await assertRejects(
      () => model.methods.getColumns.execute({ tableId: "Orders" }, context),
      Error,
      "Grist API GET /tables/Orders/columns failed with 403: forbidden",
    );
    assertEquals(writes.length, 0);
  });
});
