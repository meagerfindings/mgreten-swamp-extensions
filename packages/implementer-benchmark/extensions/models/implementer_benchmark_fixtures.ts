/**
 * Deterministic synthetic JavaScript fixtures for the implementer benchmark.
 * Never replace these fixtures with application or user data.
 *
 * @module implementer_benchmark_fixtures
 */
/** Stable identifiers for the five bundled benchmark tasks. */
export const TASK_IDS = [
  "task-01",
  "task-02",
  "task-03",
  "task-04",
  "task-05",
] as const;
/** Identifier for one bundled benchmark task. */
export type TaskId = typeof TASK_IDS[number];

/** Visible fixture files plus a hidden verifier used only in the sandbox. */
export type BenchmarkFixture = {
  id: TaskId;
  prompt: string;
  allowedPaths: readonly string[];
  files: Readonly<Record<string, string>>;
  hiddenVerifier: string;
};

const packageJson = (id: TaskId): string =>
  JSON.stringify({
    name: `benchmark-${id}`,
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  });

const fixtures: Record<TaskId, BenchmarkFixture> = {
  "task-01": {
    id: "task-01",
    prompt: `# Task 01: normalize labels

Fix \`normalizeLabels(values, limit = 8)\`. Trim strings, collapse internal whitespace, lowercase, reject non-strings/empty values, deduplicate while preserving first-seen order, and return at most \`limit\` labels. A non-positive or non-integer limit returns \`[]\`. Do not mutate input.

**Allowed path:** \`src/labels.js\` only. Expected changed lines: 30-60. Run \`node --test\`.`,
    allowedPaths: ["src/labels.js"],
    files: {
      "package.json": packageJson("task-01"),
      "PROMPT.md": `# Task 01: normalize labels

Fix \`normalizeLabels(values, limit = 8)\`. Trim strings, collapse internal whitespace, lowercase, reject non-strings/empty values, deduplicate while preserving first-seen order, and return at most \`limit\` labels. A non-positive or non-integer limit returns \`[]\`. Do not mutate input.

**Allowed path:** \`src/labels.js\` only. Expected changed lines: 30-60. Run \`node --test\`.
`,
      "src/labels.js": `export function normalizeLabels(values, limit = 8) {
  // BUG: this implementation neither validates nor normalizes correctly.
  return values.slice(0, limit);
}
`,
      "test/labels.test.js": `import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabels } from '../src/labels.js';

test('normalizes, filters, and preserves order', () => {
  const input = ['  Blue Sky ', 'BLUE   SKY', '', 7, 'Green\\nField', ' amber '];
  assert.deepEqual(normalizeLabels(input), ['blue sky', 'green field', 'amber']);
  assert.deepEqual(input, ['  Blue Sky ', 'BLUE   SKY', '', 7, 'Green\\nField', ' amber ']);
});
test('honors valid limits and rejects invalid ones', () => {
  assert.deepEqual(normalizeLabels(['a', 'b', 'c'], 2), ['a', 'b']);
  assert.deepEqual(normalizeLabels(['a'], 0), []);
  assert.deepEqual(normalizeLabels(['a'], 1.5), []);
});
`,
    },
    hiddenVerifier: `import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.env.CANDIDATE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('CANDIDATE_ROOT must be an absolute path');
const { normalizeLabels } = await import(pathToFileURL(path.join(root, 'src/labels.js')));
test('validates the input and every limit boundary', () => {
  for (const value of [undefined, null, {}, 'abc', new Set(['a'])]) assert.deepEqual(normalizeLabels(value), []);
  const values = ['a', 'b'];
  for (const limit of [-1, -0, 0, 0.5, NaN, Infinity, '2', null]) assert.deepEqual(normalizeLabels(values, limit), [], \`limit \${String(limit)}\`);
  assert.deepEqual(normalizeLabels(values, 1), ['a']); assert.deepEqual(normalizeLabels(values, Number.MAX_SAFE_INTEGER), values);
});
test('normalizes all whitespace, filters values, and deduplicates after normalization', () => {
  const input = ['\\t Foo\\u00a0 BAR \\n', 'foo bar', false, null, {}, '  ', 'İ', 'i'];
  assert.deepEqual(normalizeLabels(input, 8), ['foo bar', 'i̇', 'i']);
});
test('does not mutate the input, including when the limit stops iteration', () => {
  const input = [' B ', 'a', 'c']; const before = structuredClone(input); const output = normalizeLabels(input, 1);
  assert.deepEqual(input, before); assert.notStrictEqual(output, input); output[0] = 'changed'; assert.deepEqual(input, before);
});
`,
  },
  "task-02": {
    id: "task-02",
    prompt: `# Task 02: safe preview

Implement \`safePreview(value, maxBytes)\`. Deeply replace values of object keys matching \`password\`, \`token\`, \`secret\`, or \`authorization\` (case-insensitive) with \`[REDACTED]\`; arrays are traversed. Return JSON text whose UTF-8 byte length is at most \`maxBytes\`. If full JSON does not fit, return a valid JSON string containing the longest UTF-8-safe prefix ending with \`…\`. Circular references become \`[Circular]\`. Inputs are not mutated. \`maxBytes\` must be an integer >= 5 or throw \`RangeError\`.

**Allowed path:** \`src/safe-preview.js\` only. Expected changed lines: 30-90. Run \`node --test\`.`,
    allowedPaths: ["src/safe-preview.js"],
    files: {
      "package.json": packageJson("task-02"),
      "PROMPT.md": `# Task 02: safe preview

Implement \`safePreview(value, maxBytes)\`. Deeply replace values of object keys matching \`password\`, \`token\`, \`secret\`, or \`authorization\` (case-insensitive) with \`[REDACTED]\`; arrays are traversed. Return JSON text whose UTF-8 byte length is at most \`maxBytes\`. If full JSON does not fit, return a valid JSON string containing the longest UTF-8-safe prefix ending with \`…\`. Circular references become \`[Circular]\`. Inputs are not mutated. \`maxBytes\` must be an integer >= 5 or throw \`RangeError\`.

**Allowed path:** \`src/safe-preview.js\` only. Expected changed lines: 30-90. Run \`node --test\`.
`,
      "src/safe-preview.js": `export function safePreview(value, maxBytes) {
  return JSON.stringify(value);
}
`,
      "test/safe-preview.test.js":
        `import test from 'node:test'; import assert from 'node:assert/strict';
import { safePreview } from '../src/safe-preview.js';
test('redacts deeply without mutation', () => {
  const value = { user: 'sample', Token: 'abc', nested: [{ password: 'p', ok: true }] };
  assert.deepEqual(JSON.parse(safePreview(value, 200)), { user: 'sample', Token: '[REDACTED]', nested: [{ password: '[REDACTED]', ok: true }] });
  assert.equal(value.Token, 'abc');
});
test('bounds UTF-8 output and handles cycles', () => {
  assert.ok(Buffer.byteLength(safePreview({ text: '🙂'.repeat(20) }, 20)) <= 20);
  assert.doesNotThrow(() => JSON.parse(safePreview({ text: '🙂'.repeat(20) }, 20)));
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(JSON.parse(safePreview(cyclic, 100)).self, '[Circular]');
  assert.throws(() => safePreview({}, 2), RangeError);
});
`,
    },
    hiddenVerifier:
      `import test from 'node:test'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import path from 'node:path';
const root = process.env.CANDIDATE_ROOT; if (!root || !path.isAbsolute(root)) throw new Error('CANDIDATE_ROOT must be an absolute path');
const { safePreview } = await import(pathToFileURL(path.join(root, 'src/safe-preview.js'))); const bytes = (value) => Buffer.byteLength(value, 'utf8');
test('enforces integer byte bounds, including the minimum and exact fit', () => { for (const limit of [undefined, null, 4, -1, 5.5, NaN, Infinity, '20']) assert.throws(() => safePreview({}, limit), RangeError, String(limit)); assert.equal(safePreview('a', 5), '"a"'); const exact = JSON.stringify({ ok: true }); assert.equal(safePreview({ ok: true }, bytes(exact)), exact); });
test('redacts exact sensitive keys at arbitrary depth without changing input', () => { const input = Object.freeze({ PASSWORD: Object.freeze({ nested: true }), nested: Object.freeze([{ authorization: 'Bearer x', tokenizer: 'keep' }, { Secret: 9 }]) }); assert.deepEqual(JSON.parse(safePreview(input, 500)), { PASSWORD: '[REDACTED]', nested: [{ authorization: '[REDACTED]', tokenizer: 'keep' }, { Secret: '[REDACTED]' }] }); assert.equal(input.nested[0].authorization, 'Bearer x'); });
test('marks cycles but does not mistake repeated references for cycles', () => { const shared = { value: 1 }; const input = { first: shared, second: shared, list: [] }; input.list.push(input.list); assert.deepEqual(JSON.parse(safePreview(input, 500)), { first: { value: 1 }, second: { value: 1 }, list: ['[Circular]'] }); });
test('truncation is valid JSON, UTF-8 safe, bounded, and uses the longest prefix', () => { const full = JSON.stringify({ text: '🙂é漢字'.repeat(8) }); for (const limit of [5, 6, 7, 8, 9, 10, 17, 31]) { const output = safePreview({ text: '🙂é漢字'.repeat(8) }, limit); assert.ok(bytes(output) <= limit); const truncated = JSON.parse(output); assert.equal(typeof truncated, 'string'); assert.ok(truncated.endsWith('…')); const prefix = truncated.slice(0, -1); assert.ok(full.startsWith(prefix)); const next = [...full.slice(prefix.length)][0]; if (next) assert.ok(bytes(JSON.stringify(prefix + next + '…')) > limit); } });
test('produces valid JSON for nested arrays, null, booleans, and numbers', () => assert.deepEqual(JSON.parse(safePreview([null, true, 0, -2.5, ['x']], 100)), [null, true, 0, -2.5, ['x']]));
`,
  },
  "task-03": {
    id: "task-03",
    prompt: `# Task 03: worker config

Implement \`parseConfig(text)\`. Parse JSON object with only \`queue\`, \`concurrency\`, and optional \`retry\`. \`queue\` is a non-empty string matching \`[a-z][a-z0-9-]{0,31}\`. \`concurrency\` is integer 1..16. \`retry\` defaults to \`{ attempts: 3, delayMs: 100 }\`; when present it must be an object with only integer \`attempts\` (0..10) and \`delayMs\` (0..60000), and omitted members use defaults. Return a fresh normalized object. Throw \`ConfigError\` with useful messages for malformed JSON or invalid fields.

**Allowed path:** \`src/config.js\` only. Expected changed lines: 30-100. Run \`node --test\`.`,
    allowedPaths: ["src/config.js"],
    files: {
      "package.json": packageJson("task-03"),
      "PROMPT.md": `# Task 03: worker config

Implement \`parseConfig(text)\`. Parse JSON object with only \`queue\`, \`concurrency\`, and optional \`retry\`. \`queue\` is a non-empty string matching \`[a-z][a-z0-9-]{0,31}\`. \`concurrency\` is integer 1..16. \`retry\` defaults to \`{ attempts: 3, delayMs: 100 }\`; when present it must be an object with only integer \`attempts\` (0..10) and \`delayMs\` (0..60000), and omitted members use defaults. Return a fresh normalized object. Throw \`ConfigError\` with useful messages for malformed JSON or invalid fields.

**Allowed path:** \`src/config.js\` only. Expected changed lines: 30-100. Run \`node --test\`.
`,
      "src/config.js": `export class ConfigError extends Error {}
export function parseConfig(text) {
  return JSON.parse(text);
}
`,
      "test/config.test.js":
        `import test from 'node:test'; import assert from 'node:assert/strict';
import { ConfigError, parseConfig } from '../src/config.js';
test('normalizes defaults and partial retry', () => { assert.deepEqual(parseConfig('{"queue":"jobs","concurrency":4}'), { queue: 'jobs', concurrency: 4, retry: { attempts: 3, delayMs: 100 } }); assert.deepEqual(parseConfig('{"queue":"jobs-2","concurrency":1,"retry":{"attempts":0}}').retry, { attempts: 0, delayMs: 100 }); });
test('rejects malformed, unknown, and out-of-range config', () => { for (const text of ['{', '[]', '{"queue":"Jobs","concurrency":2}', '{"queue":"jobs","concurrency":17}', '{"queue":"jobs","concurrency":2,"extra":true}', '{"queue":"jobs","concurrency":2,"retry":{"delayMs":-1}}']) assert.throws(() => parseConfig(text), ConfigError); });
`,
    },
    hiddenVerifier:
      `import test from 'node:test'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import path from 'node:path';
const root = process.env.CANDIDATE_ROOT; if (!root || !path.isAbsolute(root)) throw new Error('CANDIDATE_ROOT must be an absolute path'); const { ConfigError, parseConfig } = await import(pathToFileURL(path.join(root, 'src/config.js'))); const rejects = (value) => assert.throws(() => parseConfig(value), (error) => error instanceof ConfigError && error.message.length > 0);
test('accepts all numeric boundaries and returns fresh normalized trees', () => { const low = parseConfig('{"queue":"a","concurrency":1,"retry":{"attempts":0,"delayMs":0}}'); assert.deepEqual(low, { queue: 'a', concurrency: 1, retry: { attempts: 0, delayMs: 0 } }); const highText = JSON.stringify({ queue: \`z\${'9'.repeat(31)}\`, concurrency: 16, retry: { attempts: 10, delayMs: 60000 } }); assert.deepEqual(parseConfig(highText).retry, { attempts: 10, delayMs: 60000 }); const first = parseConfig('{"queue":"jobs","concurrency":2}'); const second = parseConfig('{"queue":"jobs","concurrency":2}'); assert.notStrictEqual(first, second); assert.notStrictEqual(first.retry, second.retry); });
test('rejects malformed JSON, non-object roots, missing fields, and queue boundary errors', () => { for (const value of ['', '{', 'null', '[]', 'true', '1', '"x"', '{}', '{"queue":"","concurrency":1}', '{"queue":"A","concurrency":1}', \`{"queue":"a\${'0'.repeat(32)}","concurrency":1}\`, '{"queue":"a_b","concurrency":1}', '{"queue":1,"concurrency":1}', '{"queue":"a"}']) rejects(value); });
test('rejects unknown keys and every invalid numeric type/range', () => { for (const value of [0, 17, -1, 1.5, '2', null]) rejects(JSON.stringify({ queue: 'jobs', concurrency: value })); for (const retry of [null, [], true, 1, 'x', { attempts: -1 }, { attempts: 11 }, { attempts: 1.1 }, { attempts: '1' }, { delayMs: -1 }, { delayMs: 60001 }, { delayMs: 1.1 }, { delayMs: '1' }, { extra: 1 }]) rejects(JSON.stringify({ queue: 'jobs', concurrency: 1, retry })); rejects('{"queue":"jobs","concurrency":1,"extra":true}'); rejects('{"queue":"jobs","concurrency":1,"__proto__":{}}'); });
test('ConfigError has the expected error identity', () => { let error; try { parseConfig('{'); } catch (caught) { error = caught; } assert.ok(error); assert.equal(error.name, 'ConfigError'); assert.ok(error instanceof Error); });
`,
  },
  "task-04": {
    id: "task-04",
    prompt: `# Task 04: timeout and cancellation

Implement \`runWithTimeout(process, { timeoutMs, signal })\`. \`process.start()\` returns a promise; resolve with its value. On timeout, call \`process.cancel('timeout')\` once and reject with \`TimeoutError\`. On AbortSignal abort, call \`process.cancel('aborted')\` once and reject with \`AbortError\`. Validate positive integer timeout synchronously, before starting. If already aborted, do not start. Always clear timers/listeners, settle once, and suppress a late start rejection.

**Allowed path:** \`src/run-with-timeout.js\` only. Expected changed lines: 30-100. Run \`node --test\`.`,
    allowedPaths: ["src/run-with-timeout.js"],
    files: {
      "package.json": packageJson("task-04"),
      "PROMPT.md": `# Task 04: timeout and cancellation

Implement \`runWithTimeout(process, { timeoutMs, signal })\`. \`process.start()\` returns a promise; resolve with its value. On timeout, call \`process.cancel('timeout')\` once and reject with \`TimeoutError\`. On AbortSignal abort, call \`process.cancel('aborted')\` once and reject with \`AbortError\`. Validate positive integer timeout synchronously, before starting. If already aborted, do not start. Always clear timers/listeners, settle once, and suppress a late start rejection.

**Allowed path:** \`src/run-with-timeout.js\` only. Expected changed lines: 30-100. Run \`node --test\`.
`,
      "src/run-with-timeout.js": `export class TimeoutError extends Error {}
export class AbortError extends Error {}
export function runWithTimeout(process, options) {
  throw new Error('Not implemented');
}
`,
      "test/run.test.js":
        `import test from 'node:test'; import assert from 'node:assert/strict';
import { AbortError, TimeoutError, runWithTimeout } from '../src/run-with-timeout.js';
const fake = (promise) => ({ reasons: [], starts: 0, start() { this.starts++; return promise; }, cancel(reason) { this.reasons.push(reason); } });
test('returns successful result', async () => assert.equal(await runWithTimeout(fake(Promise.resolve('ok')), { timeoutMs: 20 }), 'ok'));
test('times out and cancels once', async () => { const p = fake(new Promise(() => {})); await assert.rejects(runWithTimeout(p, { timeoutMs: 5 }), TimeoutError); assert.deepEqual(p.reasons, ['timeout']); });
test('handles pre-abort without starting', async () => { const controller = new AbortController(); controller.abort(); const p = fake(Promise.resolve('no')); await assert.rejects(runWithTimeout(p, { timeoutMs: 20, signal: controller.signal }), AbortError); assert.equal(p.starts, 0); assert.deepEqual(p.reasons, ['aborted']); });
`,
    },
    hiddenVerifier:
      `import test from 'node:test'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import path from 'node:path';
const root = process.env.CANDIDATE_ROOT; if (!root || !path.isAbsolute(root)) throw new Error('CANDIDATE_ROOT must be an absolute path'); const { AbortError, TimeoutError, runWithTimeout } = await import(pathToFileURL(path.join(root, 'src/run-with-timeout.js'))); const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }; const fake = (promise) => ({ starts: 0, reasons: [], start() { this.starts++; return promise; }, cancel(reason) { this.reasons.push(reason); } });
test('validates timeout before starting', () => { for (const timeoutMs of [undefined, null, 0, -1, 1.5, NaN, Infinity, '2']) { const process = fake(Promise.resolve()); assert.throws(() => runWithTimeout(process, { timeoutMs }), RangeError); assert.equal(process.starts, 0); } });
test('propagates start fulfillment and rejection without cancellation', async () => { const success = fake(Promise.resolve('value')); assert.equal(await runWithTimeout(success, { timeoutMs: 50 }), 'value'); assert.deepEqual(success.reasons, []); const failure = new Error('start failed'); await assert.rejects(runWithTimeout(fake(Promise.reject(failure)), { timeoutMs: 50 }), (error) => error === failure); const throwing = { reasons: [], start() { throw failure; }, cancel(reason) { this.reasons.push(reason); } }; await assert.rejects(runWithTimeout(throwing, { timeoutMs: 50 }), (error) => error === failure); assert.deepEqual(throwing.reasons, []); });
test('abort wins before timeout, cancels once, and suppresses late settlement', async () => { const work = deferred(); const process = fake(work.promise); const controller = new AbortController(); const result = runWithTimeout(process, { timeoutMs: 40, signal: controller.signal }); await Promise.resolve(); controller.abort(); await assert.rejects(result, AbortError); work.reject(new Error('late')); await new Promise((resolve) => setTimeout(resolve, 50)); assert.deepEqual(process.reasons, ['aborted']); });
test('timeout wins and a later abort cannot cancel twice', async () => { const process = fake(new Promise(() => {})); const controller = new AbortController(); await assert.rejects(runWithTimeout(process, { timeoutMs: 5, signal: controller.signal }), TimeoutError); controller.abort(); await new Promise((resolve) => setTimeout(resolve, 0)); assert.deepEqual(process.reasons, ['timeout']); });
test('pre-abort does not start and active listeners are removed on success', async () => { const pre = new AbortController(); pre.abort(); const stopped = fake(Promise.resolve('no')); await assert.rejects(runWithTimeout(stopped, { timeoutMs: 20, signal: pre.signal }), AbortError); assert.equal(stopped.starts, 0); assert.deepEqual(stopped.reasons, ['aborted']); const controller = new AbortController(); let adds = 0; let removes = 0; const add = controller.signal.addEventListener.bind(controller.signal); const remove = controller.signal.removeEventListener.bind(controller.signal); controller.signal.addEventListener = (...args) => { adds++; return add(...args); }; controller.signal.removeEventListener = (...args) => { removes++; return remove(...args); }; assert.equal(await runWithTimeout(fake(Promise.resolve('ok')), { timeoutMs: 20, signal: controller.signal }), 'ok'); assert.equal(adds, 1); assert.equal(removes, 1); });
test('listeners are removed after timeout', async () => { const controller = new AbortController(); let adds = 0; let removes = 0; const add = controller.signal.addEventListener.bind(controller.signal); const remove = controller.signal.removeEventListener.bind(controller.signal); controller.signal.addEventListener = (...args) => { adds++; return add(...args); }; controller.signal.removeEventListener = (...args) => { removes++; return remove(...args); }; await assert.rejects(runWithTimeout(fake(new Promise(() => {})), { timeoutMs: 5, signal: controller.signal }), TimeoutError); assert.equal(adds, 1); assert.equal(removes, 1); });
test('a synchronous start failure clears the timer and never cancels later', async () => { const failure = new Error('synchronous start failure'); const process = { reasons: [], start() { throw failure; }, cancel(reason) { this.reasons.push(reason); } }; await assert.rejects(runWithTimeout(process, { timeoutMs: 5 }), (error) => error === failure); await new Promise((resolve) => setTimeout(resolve, 10)); assert.deepEqual(process.reasons, []); });
`,
  },
  "task-05": {
    id: "task-05",
    prompt: `# Task 05: record summary integration

Implement two modules. \`parseRecords(text)\` parses newline-delimited JSON, ignores blank lines, and returns records with non-empty string \`category\` and finite non-negative numeric \`durationMs\`; invalid lines are skipped (not thrown). Normalize category by trim/lowercase. \`summarize(text)\` uses \`parseRecords\` and returns \`{ accepted, totalDurationMs, byCategory }\`, where category keys are lexicographically sorted and each value is \`{ count, totalDurationMs }\`. Do not duplicate parsing logic.

**Allowed paths:** \`src/parse-records.js\`, \`src/summarize.js\` only. Expected changed lines: 30-120 total. Run \`node --test\`.`,
    allowedPaths: ["src/parse-records.js", "src/summarize.js"],
    files: {
      "package.json": packageJson("task-05"),
      "PROMPT.md": `# Task 05: record summary integration

Implement two modules. \`parseRecords(text)\` parses newline-delimited JSON, ignores blank lines, and returns records with non-empty string \`category\` and finite non-negative numeric \`durationMs\`; invalid lines are skipped (not thrown). Normalize category by trim/lowercase. \`summarize(text)\` uses \`parseRecords\` and returns \`{ accepted, totalDurationMs, byCategory }\`, where category keys are lexicographically sorted and each value is \`{ count, totalDurationMs }\`. Do not duplicate parsing logic.

**Allowed paths:** \`src/parse-records.js\`, \`src/summarize.js\` only. Expected changed lines: 30-120 total. Run \`node --test\`.
`,
      "src/parse-records.js": `export function parseRecords(text) {
  return [];
}
`,
      "src/summarize.js": `export function summarize(text) {
  return { accepted: 0, totalDurationMs: 0, byCategory: {} };
}
`,
      "test/integration.test.js":
        `import test from 'node:test'; import assert from 'node:assert/strict';
import { parseRecords } from '../src/parse-records.js'; import { summarize } from '../src/summarize.js';
const input = '\\n{"category":" Build ","durationMs":4}\\nnot-json\\n{"category":"test","durationMs":2.5}\\n{"category":"build","durationMs":1}\\n{"category":"bad","durationMs":-2}\\n';
test('parser filters and normalizes', () => assert.deepEqual(parseRecords(input), [{ category: 'build', durationMs: 4 }, { category: 'test', durationMs: 2.5 }, { category: 'build', durationMs: 1 }]));
test('summary integrates parser and sorts categories', () => assert.deepEqual(summarize(input), { accepted: 3, totalDurationMs: 7.5, byCategory: { build: { count: 2, totalDurationMs: 5 }, test: { count: 1, totalDurationMs: 2.5 } } }));
`,
    },
    hiddenVerifier:
      `import test from 'node:test'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import path from 'node:path';
const root = process.env.CANDIDATE_ROOT; if (!root || !path.isAbsolute(root)) throw new Error('CANDIDATE_ROOT must be an absolute path'); const { parseRecords } = await import(pathToFileURL(path.join(root, 'src/parse-records.js'))); const { summarize } = await import(pathToFileURL(path.join(root, 'src/summarize.js')));
test('skips malformed JSON and every invalid NDJSON shape', () => { const lines = ['', '   ', 'no', 'null', 'true', '1', '"x"', '[]', '{}', '{"category":"","durationMs":1}', '{"category":"  ","durationMs":1}', '{"category":1,"durationMs":1}', '{"category":"x"}', '{"category":"x","durationMs":null}', '{"category":"x","durationMs":"1"}', '{"category":"x","durationMs":-0.01}', '{"category":"x","durationMs":1e309}']; assert.deepEqual(parseRecords(lines.join('\\n')), []); });
test('accepts finite numeric boundaries, strips extra fields, and normalizes categories', () => { const text = ['{"category":" A ","durationMs":0,"ignored":true}', '{"category":"a","durationMs":5e-324}', '{"category":" MIXED\\\\tCase ","durationMs":1.25}'].join('\\r\\n'); assert.deepEqual(parseRecords(text), [{ category: 'a', durationMs: 0 }, { category: 'a', durationMs: 5e-324 }, { category: 'mixed\\tcase', durationMs: 1.25 }]); });
test('summarizes empty input and sorts category keys lexicographically', () => { assert.deepEqual(summarize('\\n bad\\n'), { accepted: 0, totalDurationMs: 0, byCategory: {} }); const text = ['{"category":"z","durationMs":2}', '{"category":"a","durationMs":1}', '{"category":"m","durationMs":3}', '{"category":"a","durationMs":4}', '{"category":"bad","durationMs":-1}'].join('\\n'); const result = summarize(text); assert.deepEqual(result, { accepted: 4, totalDurationMs: 10, byCategory: { a: { count: 2, totalDurationMs: 5 }, m: { count: 1, totalDurationMs: 3 }, z: { count: 1, totalDurationMs: 2 } } }); assert.deepEqual(Object.keys(result.byCategory), ['a', 'm', 'z']); });
test('parser returns fresh normalized records', () => { const text = '{"category":"x","durationMs":1}'; const first = parseRecords(text); const second = parseRecords(text); assert.notStrictEqual(first, second); assert.notStrictEqual(first[0], second[0]); });
test('summarizes valid category names that overlap object prototype properties', () => { const text = ['{"category":"__proto__","durationMs":1}', '{"category":"constructor","durationMs":2}', '{"category":"toString","durationMs":3}'].join('\\n'); const result = summarize(text); assert.deepEqual(Object.keys(result.byCategory), ['__proto__', 'constructor', 'tostring']); assert.deepEqual(result.byCategory.__proto__, { count: 1, totalDurationMs: 1 }); assert.deepEqual(result.byCategory.constructor, { count: 1, totalDurationMs: 2 }); assert.deepEqual(result.byCategory.tostring, { count: 1, totalDurationMs: 3 }); });
`,
  },
};

/** Returns the immutable fixture associated with an identifier. */
export function getFixture(id: TaskId): BenchmarkFixture {
  return fixtures[id];
}

/** Checks whether a string identifies a bundled task. */
export function isTaskId(value: string): value is TaskId {
  return (TASK_IDS as readonly string[]).includes(value);
}

/** Returns all bundled fixtures in stable execution order. */
export function allFixtures(): readonly BenchmarkFixture[] {
  return TASK_IDS.map(getFixture);
}
