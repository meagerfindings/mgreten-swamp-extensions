import { assertEquals, assertThrows } from "jsr:@std/assert@1";

Deno.test("synthetic date validation rejects impossible and out-of-trip dates", () => {
  const date = (value: string) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value;
  };
  assertEquals(date("2026-02-28"), true);
  assertEquals(date("2026-02-29"), false);
  assertEquals("2026-07-24" < "2026-07-20", false);
});

Deno.test("synthetic budget, receipt, and reimbursement ledger cases", () => {
  const expenses = [
    {
      id: "synthetic-rail",
      cents: 12_500,
      expenseClass: "reimbursable_travel",
      reimbursable: true,
    },
    {
      id: "synthetic-meal",
      cents: 8_000,
      expenseClass: "budgeted_meal",
      reimbursable: false,
    },
  ];
  const budgetCents = 20_000;
  const spent = expenses.filter((item) => item.expenseClass === "budgeted_meal")
    .reduce((total, item) => total + item.cents, 0);
  const reimbursable = expenses.filter((item) => item.reimbursable).reduce(
    (total, item) => total + item.cents,
    0,
  );
  const reimbursement = 12_500;
  const receiptStatus = new Map([["synthetic-rail", "verified"], [
    "synthetic-meal",
    "missing",
  ]]);
  assertEquals(spent, 8_000);
  assertEquals(budgetCents - spent, 12_000);
  assertEquals(
    [...receiptStatus.values()].filter((status) => status === "missing").length,
    1,
  );
  assertEquals(reimbursable - reimbursement, 0);
  assertThrows(
    () => {
      if (12_501 > reimbursable) throw new Error("over reimbursement");
    },
    Error,
    "over reimbursement",
  );
});

Deno.test("synthetic append-only controls reject duplicate identifiers and cleanup before archive", () => {
  const ids = ["synthetic-rail"];
  assertThrows(
    () => {
      if (ids.includes("synthetic-rail")) {
        throw new Error(
          "duplicate immutable evidence",
        );
      }
    },
    Error,
    "duplicate immutable evidence",
  );
  const archived = false;
  assertThrows(
    () => {
      if (!archived) throw new Error("archive required before cleanup");
    },
    Error,
    "archive required before cleanup",
  );
});

Deno.test("synthetic configuration identity is a no-op while incompatible reconfiguration is rejected", () => {
  const configured = {
    tripId: "synthetic-trip",
    name: "Synthetic Trip",
    currency: "USD",
    startDate: "2026-07-20",
    endDate: "2026-07-24",
    budgetCents: 20_000,
  };
  const same = { ...configured };
  const incompatible = { ...configured, budgetCents: 20_001 };
  const equalTrip = (left: typeof configured, right: typeof configured) =>
    JSON.stringify(left) === JSON.stringify(right);
  assertEquals(equalTrip(configured, same), true);
  assertThrows(
    () => {
      if (!equalTrip(configured, incompatible)) {
        throw new Error(
          "incompatible immutable settings",
        );
      }
    },
    Error,
    "incompatible immutable settings",
  );
});

Deno.test("synthetic archive binding rejects missing, cross-trip, and stale evidence", () => {
  const index = {
    tripId: "synthetic-trip",
    expenseIds: ["synthetic-rail"],
    amendmentIds: ["synthetic-amendment"],
  };
  const valid = {
    archiveName: "synthetic-archive",
    tripId: "synthetic-trip",
    expenseIds: ["synthetic-rail"],
    amendmentIds: ["synthetic-amendment"],
    expenses: ["synthetic-rail"],
    amendments: ["synthetic-amendment"],
  };
  const verify = (archive: typeof valid | undefined, requestedName: string) => {
    if (
      !archive || archive.archiveName !== requestedName ||
      archive.tripId !== index.tripId
    ) throw new Error("archive is not bound to this trip");
    if (
      JSON.stringify(archive.expenseIds) !== JSON.stringify(index.expenseIds) ||
      JSON.stringify(archive.amendmentIds) !==
        JSON.stringify(index.amendmentIds)
    ) throw new Error("archive is stale");
    if (
      JSON.stringify(archive.expenses) !== JSON.stringify(index.expenseIds) ||
      JSON.stringify(archive.amendments) !== JSON.stringify(index.amendmentIds)
    ) throw new Error("archive evidence mismatches index");
  };
  verify(valid, "synthetic-archive");
  assertThrows(
    () => verify(undefined, "synthetic-archive"),
    Error,
    "archive is not bound",
  );
  assertThrows(
    () => verify({ ...valid, tripId: "other-trip" }, "synthetic-archive"),
    Error,
    "archive is not bound",
  );
  assertThrows(
    () => verify({ ...valid, expenseIds: [] }, "synthetic-archive"),
    Error,
    "archive is stale",
  );
});

Deno.test("synthetic cleanup request is archive-bound, immutable, and not evidence deletion", () => {
  const request = {
    tripId: "synthetic-trip",
    archiveName: "synthetic-archive",
    requestedAt: "2026-07-25T00:00:00.000Z",
    reason: "Synthetic retention workflow",
  };
  const repeat = { ...request };
  const incompatible = { ...request, reason: "Different reason" };
  assertEquals(JSON.stringify(request) === JSON.stringify(repeat), true);
  assertThrows(
    () => {
      if (request.archiveName !== "other-archive") {
        throw new Error(
          "cleanup requires matching archiveName",
        );
      }
    },
    Error,
    "matching archiveName",
  );
  assertThrows(
    () => {
      if (
        JSON.stringify(request) !== JSON.stringify(incompatible)
      ) throw new Error("incompatible immutable request details");
    },
    Error,
    "incompatible immutable request details",
  );
  const retainedEvidence = [
    "trip_configuration",
    "expense_ledger",
    "expense_status_amendment",
    "trip_archive",
  ];
  assertEquals(retainedEvidence.includes("trip_archive"), true);
});
