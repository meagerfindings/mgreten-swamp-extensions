/** Deterministic, resource-backed expense tracking for trips and retreats. */
import { z } from "npm:zod@4";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Cents = z.number().int().min(0).max(100_000_000);
const Id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{1,63}$`));
const Text = z.string().trim().min(1).max(200);
const GlobalArgumentsSchema = z.object({
  tripId: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
}).strict();
const ProvidedMealSchema = z.object({
  date: DateSchema,
  meal: z.enum(["breakfast", "lunch", "dinner", "other"]),
  note: z.string().trim().max(300).optional(),
}).strict();
const TripSchema = z.object({
  tripId: GlobalArgumentsSchema.shape.tripId,
  title: Text,
  startDate: DateSchema,
  endDate: DateSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  mealBudgetCents: Cents.nullable(),
  providedMeals: z.array(ProvidedMealSchema).max(128).default([]),
}).strict();
const ExpenseSchema = z.object({
  expenseId: Id("exp"),
  occurredOn: DateSchema,
  expenseClass: z.enum(["budgeted_meal", "reimbursable_travel", "non_budget"]),
  category: Text,
  merchant: Text,
  amountCents: Cents,
  receiptStatus: z.enum(["missing", "attached", "not_required"]),
  reimbursable: z.boolean(),
  note: z.string().trim().max(500).optional(),
}).strict();
const AmendmentSchema = z.object({
  amendmentId: Id("amd"),
  expenseId: Id("exp"),
  receiptStatus: z.enum(["missing", "attached", "not_required"]).optional(),
  submissionStatus: z.enum([
    "not_submitted",
    "submitted",
    "approved",
    "rejected",
  ]).optional(),
  reimbursementCents: Cents.optional(),
  updatedAt: z.string().datetime(),
}).strict();
const IndexSchema = z.object({
  tripId: GlobalArgumentsSchema.shape.tripId,
  expenseIds: z.array(Id("exp")),
  amendmentIds: z.array(Id("amd")),
  archived: z.boolean(),
  archiveName: z.string().optional(),
  cleanupRequested: z.boolean(),
  cleanupArchiveName: z.string().optional(),
}).strict();
const LedgerRowSchema = z.object({
  expenseId: Id("exp"),
  occurredOn: DateSchema,
  expenseClass: z.string(),
  category: z.string(),
  merchant: z.string(),
  amountCents: Cents,
  receiptStatus: z.string(),
  submissionStatus: z.string(),
  reimbursable: z.boolean(),
  reimbursementCents: Cents,
}).strict();
const LedgerReportSchema = z.object({
  tripId: GlobalArgumentsSchema.shape.tripId,
  rows: z.array(LedgerRowSchema),
}).strict();
const DashboardSchema = z.object({
  tripId: GlobalArgumentsSchema.shape.tripId,
  currency: z.string(),
  budget: z.object({
    mealBudgetCents: Cents.nullable(),
    mealSpentCents: Cents,
    mealRemainingCents: z.number().int().nullable(),
    overBudget: z.boolean(),
    providedMealCount: z.number().int(),
  }).strict(),
  reimbursable: z.object({
    totalCents: Cents,
    reimbursedCents: Cents,
    outstandingCents: Cents,
  }).strict(),
  expenseLedger: z.array(LedgerRowSchema),
  receiptSubmission: z.array(LedgerRowSchema),
  categories: z.array(
    z.object({
      category: z.string(),
      expenseClass: z.string(),
      totalCents: Cents,
    }).strict(),
  ),
  days: z.array(
    z.object({
      date: DateSchema,
      budgetedMealCents: Cents,
      reimbursableTravelCents: Cents,
      nonBudgetCents: Cents,
      providedMealCount: z.number().int(),
    }).strict(),
  ),
}).strict();
const ArchiveSchema = z.object({
  archiveName: Text,
  trip: TripSchema,
  index: IndexSchema,
  ledger: LedgerReportSchema,
  dashboard: DashboardSchema,
  exportedAt: z.string().datetime(),
}).strict();
const CleanupSchema = z.object({
  tripId: GlobalArgumentsSchema.shape.tripId,
  archiveName: Text,
  requestedAt: z.string().datetime(),
  reason: z.string().trim().max(500).optional(),
}).strict();
type MethodResult = { dataHandles: unknown[] };
type ModelContext = {
  globalArgs: z.infer<typeof GlobalArgumentsSchema>;
  logger: {
    info: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
  readResource: (name: string) => Promise<unknown | null>;
  writeResource: (
    specName: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}
function ensureDateRange(startDate: string, endDate: string): void {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error(
      "Trip dates must be real ISO dates with startDate on or before endDate.",
    );
  }
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function input(args: unknown): Record<string, unknown> {
  const { tripId: _tripId, ...rest } = (args ?? {}) as Record<string, unknown>;
  return rest;
}
async function optional(
  context: ModelContext,
  name: string,
): Promise<unknown | undefined> {
  try {
    const value = await context.readResource(name);
    return value === null ? undefined : value;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("not found")
    ) return undefined;
    throw error;
  }
}
async function lifecycle(
  context: ModelContext,
  operation: string,
  work: () => Promise<MethodResult>,
): Promise<MethodResult> {
  context.logger.info("Trip expense tracker method started", { operation });
  try {
    const output = await work();
    context.logger.info("Trip expense tracker method completed", {
      operation,
      dataHandleCount: output.dataHandles.length,
    });
    return output;
  } catch (error) {
    context.logger.error("Trip expense tracker method failed", { operation });
    throw error;
  }
}
function active(index: z.infer<typeof IndexSchema>): void {
  if (index.archived || index.cleanupRequested) {
    throw new Error(
      "Trip is locked; no additional expense evidence may be recorded.",
    );
  }
}
async function state(context: ModelContext) {
  const tripId = context.globalArgs.tripId;
  const trip = TripSchema.parse(
    await context.readResource(`${tripId}--configuration`),
  );
  const index = IndexSchema.parse(
    await context.readResource(`${tripId}--index`),
  );
  const expenses = await Promise.all(
    index.expenseIds.map(async (id) =>
      ExpenseSchema.parse(await context.readResource(`${id}--ledger`))
    ),
  );
  const amendments = await Promise.all(
    index.amendmentIds.map(async (id) =>
      AmendmentSchema.parse(await context.readResource(`${id}--amendment`))
    ),
  );
  return { tripId, trip, index, expenses, amendments };
}
function rows(
  expenses: z.infer<typeof ExpenseSchema>[],
  amendments: z.infer<typeof AmendmentSchema>[],
) {
  const latest = new Map<string, z.infer<typeof AmendmentSchema>>();
  for (const amendment of amendments) {
    latest.set(amendment.expenseId, {
      ...latest.get(amendment.expenseId),
      ...amendment,
    });
  }
  return expenses.map((expense) => {
    const amendment = latest.get(expense.expenseId);
    return LedgerRowSchema.parse({
      expenseId: expense.expenseId,
      occurredOn: expense.occurredOn,
      expenseClass: expense.expenseClass,
      category: expense.category,
      merchant: expense.merchant,
      amountCents: expense.amountCents,
      receiptStatus: amendment?.receiptStatus ?? expense.receiptStatus,
      submissionStatus: amendment?.submissionStatus ?? "not_submitted",
      reimbursable: expense.reimbursable,
      reimbursementCents: amendment?.reimbursementCents ?? 0,
    });
  }).sort((a, b) =>
    `${a.occurredOn}|${a.expenseId}`.localeCompare(
      `${b.occurredOn}|${b.expenseId}`,
    )
  );
}
function report(
  tripId: string,
  expenses: z.infer<typeof ExpenseSchema>[],
  amendments: z.infer<typeof AmendmentSchema>[],
) {
  return LedgerReportSchema.parse({ tripId, rows: rows(expenses, amendments) });
}
function dashboard(
  trip: z.infer<typeof TripSchema>,
  ledger: z.infer<typeof LedgerReportSchema>,
) {
  const mealRows = ledger.rows.filter((row) =>
    row.expenseClass === "budgeted_meal"
  );
  const travelRows = ledger.rows.filter((row) =>
    row.expenseClass === "reimbursable_travel"
  );
  const mealSpentCents = mealRows.reduce(
    (total, row) => total + row.amountCents,
    0,
  );
  const reimbursableRows = ledger.rows.filter((row) => row.reimbursable);
  const reimbursableCents = reimbursableRows.reduce(
    (total, row) => total + row.amountCents,
    0,
  );
  const reimbursedCents = reimbursableRows.reduce(
    (total, row) => total + row.reimbursementCents,
    0,
  );
  if (reimbursedCents > reimbursableCents) {
    throw new Error(
      "Reimbursement amendments exceed immutable reimbursable expense evidence.",
    );
  }
  const keys = [
    ...new Set(
      ledger.rows.map((row) => `${row.expenseClass}\u0000${row.category}`),
    ),
  ].sort();
  const categories = keys.map((key) => {
    const [expenseClass, category] = key.split("\u0000");
    return {
      expenseClass,
      category,
      totalCents: ledger.rows.filter((row) =>
        row.expenseClass === expenseClass && row.category === category
      ).reduce((total, row) => total + row.amountCents, 0),
    };
  });
  const dates = [
    ...new Set([
      ...ledger.rows.map((row) => row.occurredOn),
      ...trip.providedMeals.map((meal) => meal.date),
    ]),
  ].sort();
  const days = dates.map((date) => ({
    date,
    budgetedMealCents: mealRows.filter((row) => row.occurredOn === date).reduce(
      (total, row) => total + row.amountCents,
      0,
    ),
    reimbursableTravelCents: travelRows.filter((row) => row.occurredOn === date)
      .reduce((total, row) => total + row.amountCents, 0),
    nonBudgetCents: ledger.rows.filter((row) =>
      row.occurredOn === date && row.expenseClass === "non_budget"
    ).reduce((total, row) => total + row.amountCents, 0),
    providedMealCount:
      trip.providedMeals.filter((meal) => meal.date === date).length,
  }));
  const remaining = trip.mealBudgetCents === null
    ? null
    : trip.mealBudgetCents - mealSpentCents;
  return DashboardSchema.parse({
    tripId: trip.tripId,
    currency: trip.currency,
    budget: {
      mealBudgetCents: trip.mealBudgetCents,
      mealSpentCents,
      mealRemainingCents: remaining,
      overBudget: remaining !== null && remaining < 0,
      providedMealCount: trip.providedMeals.length,
    },
    reimbursable: {
      totalCents: reimbursableCents,
      reimbursedCents,
      outstandingCents: reimbursableCents - reimbursedCents,
    },
    expenseLedger: ledger.rows,
    receiptSubmission: ledger.rows.filter((row) =>
      row.reimbursable &&
      (row.receiptStatus === "missing" ||
        row.submissionStatus === "not_submitted")
    ),
    categories,
    days,
  });
}

/**
 * Swamp model definition for deterministic, append-only trip expense accounting.
 *
 * The model persists configuration, original expense evidence, status amendments,
 * tabular reports, and archive-bound cleanup intent as named Swamp resources.
 */
export const model = {
  type: "@mgreten/trip-expense-tracker",
  version: "2026.07.28.1",
  // Initial version: upgrades are intentionally omitted because no predecessor exists. Future versions must add ordered pure migrations.
  globalArguments: GlobalArgumentsSchema,
  // Runtime method arguments remain strictly validated before every resource write.

  resources: {
    trip_configuration: {
      description: "Trip configuration",
      schema: TripSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    trip_index: {
      description: "Trip evidence index",
      schema: IndexSchema,
      lifetime: "infinite",
      garbageCollection: 2000,
    },
    expense_ledger: {
      description: "Immutable expense evidence",
      schema: ExpenseSchema,
      lifetime: "infinite",
      garbageCollection: 10000,
    },
    expense_amendment: {
      description: "Append-only status amendment",
      schema: AmendmentSchema,
      lifetime: "infinite",
      garbageCollection: 10000,
    },
    trip_ledger_report: {
      description: "Deterministic ledger report",
      schema: LedgerReportSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    trip_dashboard: {
      description: "Deterministic dashboard",
      schema: DashboardSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    trip_archive: {
      description: "Portable archive evidence",
      schema: ArchiveSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    cleanup_request: {
      description: "Cleanup intent evidence",
      schema: CleanupSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    configureTrip: {
      description: "Configure immutable trip settings",
      arguments: TripSchema,
      execute: (args: unknown, context: ModelContext) =>
        lifecycle(context, "configureTrip", async () => {
          const trip = TripSchema.parse({
            ...TripSchema.parse(args),
            tripId: context.globalArgs.tripId,
          });
          ensureDateRange(trip.startDate, trip.endDate);
          for (const meal of trip.providedMeals) {
            if (
              !validDate(meal.date) || meal.date < trip.startDate ||
              meal.date > trip.endDate
            ) {
              throw new Error(
                "Provided meals must be real dates within the trip range.",
              );
            }
          }
          const existing = await optional(
            context,
            `${trip.tripId}--configuration`,
          );
          if (existing !== undefined) {
            if (!same(TripSchema.parse(existing), trip)) {
              throw new Error(
                "Trip is already configured with incompatible immutable settings.",
              );
            }
            return { dataHandles: [] };
          }
          const config = await context.writeResource(
            "trip_configuration",
            `${trip.tripId}--configuration`,
            trip,
          );
          const index = await context.writeResource(
            "trip_index",
            `${trip.tripId}--index`,
            {
              tripId: trip.tripId,
              expenseIds: [],
              amendmentIds: [],
              archived: false,
              cleanupRequested: false,
            },
          );
          return { dataHandles: [config, index] };
        }),
    },
    recordExpense: {
      description: "Record immutable expense evidence",
      arguments: ExpenseSchema.and(GlobalArgumentsSchema),
      execute: (args: unknown, context: ModelContext) =>
        lifecycle(context, "recordExpense", async () => {
          const expense = ExpenseSchema.parse(input(args));
          const current = await state(context);
          active(current.index);
          if (
            !validDate(expense.occurredOn) ||
            expense.occurredOn < current.trip.startDate ||
            expense.occurredOn > current.trip.endDate
          ) {
            throw new Error(
              "Expense date must be within the configured trip range.",
            );
          }
          if (
            expense.expenseClass === "budgeted_meal" && expense.reimbursable
          ) throw new Error("Budgeted meals cannot be reimbursable.");
          if (
            expense.expenseClass === "reimbursable_travel" &&
            !expense.reimbursable
          ) throw new Error("Reimbursable travel must be marked reimbursable.");
          if (current.index.expenseIds.includes(expense.expenseId)) {
            throw new Error("Expense IDs are immutable and unique.");
          }
          const ledger = await context.writeResource(
            "expense_ledger",
            `${expense.expenseId}--ledger`,
            expense,
          );
          const index = await context.writeResource(
            "trip_index",
            `${current.tripId}--index`,
            {
              ...current.index,
              expenseIds: [...current.index.expenseIds, expense.expenseId],
            },
          );
          return { dataHandles: [ledger, index] };
        }),
    },
    updateExpenseStatus: {
      description: "Append expense status evidence",
      arguments: AmendmentSchema.and(GlobalArgumentsSchema),
      execute: (args: unknown, context: ModelContext) =>
        lifecycle(context, "updateExpenseStatus", async () => {
          const amendment = AmendmentSchema.parse(input(args));
          const current = await state(context);
          active(current.index);
          if (
            !current.index.expenseIds.includes(amendment.expenseId) ||
            current.index.amendmentIds.includes(amendment.amendmentId)
          ) {
            throw new Error(
              "Amendment must target an indexed expense and use a unique ID.",
            );
          }
          const expense = current.expenses.find((item) =>
            item.expenseId === amendment.expenseId
          )!;
          if (
            !expense.reimbursable && amendment.reimbursementCents !== undefined
          ) {
            throw new Error(
              "Only reimbursable expenses may record reimbursement.",
            );
          }
          if (
            amendment.reimbursementCents !== undefined &&
            amendment.reimbursementCents > expense.amountCents
          ) {
            throw new Error(
              "Reimbursement cannot exceed immutable expense amount.",
            );
          }
          const record = await context.writeResource(
            "expense_amendment",
            `${amendment.amendmentId}--amendment`,
            amendment,
          );
          const index = await context.writeResource(
            "trip_index",
            `${current.tripId}--index`,
            {
              ...current.index,
              amendmentIds: [
                ...current.index.amendmentIds,
                amendment.amendmentId,
              ],
            },
          );
          return { dataHandles: [record, index] };
        }),
    },
    listLedger: {
      description: "Persist a deterministic ledger report",
      arguments: z.object({}).strict().and(GlobalArgumentsSchema),
      execute: (_args: unknown, context: ModelContext) =>
        lifecycle(context, "listLedger", async () => {
          const current = await state(context);
          const ledger = report(
            current.tripId,
            current.expenses,
            current.amendments,
          );
          const handle = await context.writeResource(
            "trip_ledger_report",
            `${current.tripId}--ledger-report`,
            ledger,
          );
          return { dataHandles: [handle] };
        }),
    },
    buildDashboard: {
      description: "Persist a deterministic dashboard",
      arguments: z.object({}).strict().and(GlobalArgumentsSchema),
      execute: (_args: unknown, context: ModelContext) =>
        lifecycle(context, "buildDashboard", async () => {
          const current = await state(context);
          const dash = dashboard(
            current.trip,
            report(current.tripId, current.expenses, current.amendments),
          );
          const handle = await context.writeResource(
            "trip_dashboard",
            `${current.tripId}--dashboard`,
            dash,
          );
          return { dataHandles: [handle] };
        }),
    },
    exportArchive: {
      description: "Persist a portable archive",
      arguments: z.object({
        archiveName: Text,
        exportedAt: z.string().datetime(),
      }).strict().and(GlobalArgumentsSchema),
      execute: (args: unknown, context: ModelContext) =>
        lifecycle(context, "exportArchive", async () => {
          const archiveInput = z.object({
            archiveName: Text,
            exportedAt: z.string().datetime(),
          }).strict().parse(input(args));
          const current = await state(context);
          active(current.index);
          if (await optional(context, `${archiveInput.archiveName}--archive`)) {
            throw new Error("Archive names are immutable and unique.");
          }
          const ledger = report(
            current.tripId,
            current.expenses,
            current.amendments,
          );
          const archive = ArchiveSchema.parse({
            archiveName: archiveInput.archiveName,
            trip: current.trip,
            index: current.index,
            ledger,
            dashboard: dashboard(current.trip, ledger),
            exportedAt: archiveInput.exportedAt,
          });
          const handle = await context.writeResource(
            "trip_archive",
            `${archiveInput.archiveName}--archive`,
            archive,
          );
          return { dataHandles: [handle] };
        }),
    },
    archiveTrip: {
      description: "Lock verified archived evidence",
      arguments: z.object({ archiveName: Text }).strict().and(
        GlobalArgumentsSchema,
      ),
      execute: (args: unknown, context: ModelContext) =>
        lifecycle(context, "archiveTrip", async () => {
          const { archiveName } = z.object({ archiveName: Text }).strict()
            .parse(input(args));
          const current = await state(context);
          const archive = ArchiveSchema.parse(
            await context.readResource(`${archiveName}--archive`),
          );
          if (
            !same(archive.trip, current.trip) ||
            !same(archive.index.expenseIds, current.index.expenseIds) ||
            !same(archive.index.amendmentIds, current.index.amendmentIds)
          ) {
            throw new Error(
              "Archive does not exactly bind current trip evidence.",
            );
          }
          if (current.index.archived) {
            if (current.index.archiveName !== archiveName) {
              throw new Error(
                "Trip already archived under a different archive.",
              );
            }
            return { dataHandles: [] };
          }
          const handle = await context.writeResource(
            "trip_index",
            `${current.tripId}--index`,
            { ...current.index, archived: true, archiveName },
          );
          return { dataHandles: [handle] };
        }),
    },
    requestCleanup: {
      description: "Record archive-bound cleanup intent",
      arguments: z.object({
        archiveName: Text,
        requestedAt: z.string().datetime(),
        reason: z.string().trim().max(500).optional(),
      }).strict().and(GlobalArgumentsSchema),
      execute: (args: unknown, context: ModelContext) =>
        lifecycle(context, "requestCleanup", async () => {
          const request = z.object({
            archiveName: Text,
            requestedAt: z.string().datetime(),
            reason: z.string().trim().max(500).optional(),
          }).strict().parse(input(args));
          const current = await state(context);
          if (
            !current.index.archived ||
            current.index.archiveName !== request.archiveName
          ) {
            throw new Error(
              "Cleanup intent requires the matching archived trip.",
            );
          }
          if (current.index.cleanupRequested) return { dataHandles: [] };
          const record = await context.writeResource(
            "cleanup_request",
            `${request.archiveName}--cleanup`,
            { tripId: current.tripId, ...request },
          );
          const index = await context.writeResource(
            "trip_index",
            `${current.tripId}--index`,
            {
              ...current.index,
              cleanupRequested: true,
              cleanupArchiveName: request.archiveName,
            },
          );
          return { dataHandles: [record, index] };
        }),
    },
  },
};
