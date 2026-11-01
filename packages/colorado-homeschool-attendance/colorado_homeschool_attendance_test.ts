import { strict as assert } from "node:assert";
import { model } from "./colorado_homeschool_attendance.ts";

Deno.test("schemaValidation preserves keyed column lists and rejects invalid members", () => {
  const schema = model.resources.schemaValidation.schema;
  const valid = {
    existingTables: ["LearningSessions"],
    missingTables: [],
    missingColumns: { LearningSessions: ["approved_at"] },
    tablesCreated: [],
    columnsAdded: { LearningSessions: ["approved_at"] },
    manualStepsNeeded: [],
    dryRun: false,
    timestamp: "2026-10-14T00:00:00.000Z",
  };

  assert.deepEqual(schema.parse(valid), valid);
  assert.throws(() =>
    schema.parse({
      ...valid,
      missingColumns: { LearningSessions: [42] },
    })
  );
});
