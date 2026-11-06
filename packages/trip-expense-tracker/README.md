# Trip Expense Tracker for Swamp

A deterministic, resource-backed Swamp model for recording and reporting expenses for trips, retreats, and onsite events.

## Scope

- Stores configuration, append-only expense evidence, status amendments, and archive/cleanup intent records as Swamp resources.
- Tracks configured meal-budget categories separately from reimbursable non-budget categories.
- Treats provided meals as context only; they do not consume a meal budget.
- Uses integer cents to avoid floating-point currency errors.
- Produces sorted ledger, dashboard, receipt/submission, reimbursement, and portable archive data.

This extension does not connect to card providers, submit reimbursements, upload receipts, delete evidence, or publish data externally.

## Model type

`@mgreten/trip-expense-tracker`

## Lifecycle

1. Run `configureTrip` once with a stable configuration. An identical configuration is idempotent; an incompatible replacement is rejected.
2. Run `recordExpense` for each immutable expense entry.
3. Run `updateExpenseStatus` to append receipt/submission status evidence rather than edit the original expense.
4. Use `listLedger` and `buildDashboard` for deterministic data suitable for a UI or chat table.
5. Run `exportArchive` and then `archiveTrip` to freeze a verified archive of current indexed evidence.
6. `requestCleanup` records an archive-bound cleanup intent only. It never deletes records or proves external retention/transmission.

## Currency

All monetary inputs and results are integer cents. For example, `1707` represents $17.07 in USD.

## Verification expectations

Run the colocated unit tests, execute a throwaway model instance through each lifecycle method, and query the resulting Swamp data artifacts before relying on the model for a real trip.

## License

MIT. See [LICENSE](LICENSE).

## Example

Create an instance with a stable `tripId`, then configure it and record an
expense. CLI JSON input preserves numeric cents and boolean fields.

```bash
swamp model method run my-trip configureTrip --input '{
  "tripId":"spring-retreat-2027",
  "title":"Spring retreat",
  "startDate":"2027-04-20",
  "endDate":"2027-04-22",
  "currency":"USD",
  "mealBudgetCents":14500,
  "providedMeals":[{"date":"2027-04-21","meal":"lunch"}]
}'

swamp model method run my-trip recordExpense --input '{
  "expenseId":"exp_dinner1",
  "occurredOn":"2027-04-20",
  "expenseClass":"budgeted_meal",
  "category":"dinner",
  "merchant":"Example Restaurant",
  "amountCents":2875,
  "receiptStatus":"attached",
  "reimbursable":false
}'
```

Build a dashboard after recording expenses. Its `budget` section uses only
`budgeted_meal` rows, while `reimbursable` is maintained separately.

```json
{
  "budget": {
    "mealBudgetCents": 14500,
    "mealSpentCents": 2875,
    "mealRemainingCents": 11625
  },
  "reimbursable": {
    "totalCents": 1800,
    "outstandingCents": 1800
  }
}
```

### Expense classes

- `budgeted_meal`: counts against the configured meal budget and cannot be reimbursable.
- `reimbursable_travel`: tracks an eligible non-meal reimbursement and never reduces the meal budget.
- `non_budget`: records an out-of-budget item without treating it as a reimbursement.

Receipt and submission changes are append-only amendments. The model retains
original evidence and uses archive binding before recording any cleanup intent.
