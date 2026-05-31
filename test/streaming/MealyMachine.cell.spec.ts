import * as fs from 'node:fs';
import * as path from 'node:path';

import { step } from '../../lib/streaming/MealyMachine';
import { emissionKind, eventByName, stateByName } from './MealyTestSupport';

/**
 * Cell-level content tests for `step(state, event)`.
 *
 * Each row of `mealy-table.csv` is one cell of the transition function:
 * a `(source, event, outcome) → (next, emissions)` record. This file is
 * one parameterised test over the table; the CSV is the executable spec,
 * the test is the witness that the implementation renders the spec
 * faithfully.
 *
 * Cross-language note: the CSV is the canonical table shared with the
 * Java and Python implementations. Java and TypeScript read it
 * verbatim; Python applies the φ bijection at row-load time to map the
 * Java/TS `RapItem(outcome)` discriminator to the three Python event
 * types `RapItem` / `RapEpsilon` / `RapObligationFailure`, and skips
 * the `PdpError` / `RapError` rows that are out of Python's δ.
 *
 * Semantic-subset claims (Lean theorems) live in
 * `MealyMachine.invariant.spec.ts`.
 */

interface Row {
  readonly from: string;
  readonly event: string;
  readonly outcome: string;
  readonly to: string;
  readonly emissions: string;
}

const loadRows = (): ReadonlyArray<Row> => {
  const raw = fs.readFileSync(path.join(__dirname, 'mealy-table.csv'), 'utf-8');
  const lines = raw
    .split('\n')
    .slice(1)
    .filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    const columns = line.split(',');
    if (columns.length !== 5) {
      throw new Error(`Malformed CSV row (expected 5 columns): ${line}`);
    }
    const [from, event, outcome, to, emissions] = columns;
    return { from, event, outcome, to, emissions };
  });
};

const parseEmissions = (raw: string): ReadonlyArray<string> => {
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  return raw.split('|');
};

const rows = loadRows();

describe('MealyMachine cells', () => {
  test.each(rows)('$from × $event($outcome) → $to : [$emissions]', (row) => {
    const sourceState = stateByName(row.from);
    const triggerEvent = eventByName(row.event, row.outcome);
    const expectedState = stateByName(row.to);
    const expectedEmissions = parseEmissions(row.emissions);

    const result = step(sourceState, triggerEvent);

    expect(result.newState.type).toBe(expectedState.type);
    expect(result.emissions.map(emissionKind)).toEqual(expectedEmissions);
  });
});
