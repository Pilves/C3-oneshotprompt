import { readFileSync } from 'node:fs';
import { ingest } from './ingest.js';
import { createIndex, search } from './search.js';
import { FINDING_TYPES } from './params.js';

/**
 * The one place the HTTP API and the MCP tools read from, so both always give the same answers.
 * Returned objects are shared, not copied: callers must treat them as read-only.
 * @param {unknown} dataset parsed findings.json
 */
export function createStore(dataset) {
  const { findings, report } = ingest(dataset);
  const index = createIndex(findings);
  const byId = new Map(findings.map((finding) => [finding.id.toUpperCase(), finding]));
  const cases = summariseCases(findings);

  return {
    stats: report,
    /** @param {import('./params.js').SearchParams} params the value from parseSearchParams */
    search: (params) => search(index, params),
    /** @param {unknown} id */
    getFinding(id) {
      if (typeof id !== 'string') return null;
      return byId.get(id.trim().toUpperCase()) ?? null;
    },
    listCases: () => cases,
  };
}

/** @param {string} filePath */
export function loadStore(filePath) {
  try {
    return createStore(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch (error) {
    throw new Error(`Cannot load ${filePath}: ${error.message}`, { cause: error });
  }
}

/** Counts canonical findings only; re-ingested copies are counted separately as duplicateCount. */
function summariseCases(findings) {
  const byCase = new Map();
  let unassigned = 0;
  for (const finding of findings) {
    const canonical = finding.duplicateOf === null;
    if (canonical && finding.caseIds.length === 0) unassigned += 1;
    // A finding in two cases counts in both: it is the link between them.
    for (const caseId of finding.caseIds) {
      if (!byCase.has(caseId)) {
        byCase.set(caseId, {
          caseId,
          findingCount: 0,
          duplicateCount: 0,
          types: Object.fromEntries(FINDING_TYPES.map((type) => [type, 0])),
          firstObservedAt: null,
          lastObservedAt: null,
        });
      }
      const summary = byCase.get(caseId);
      if (!canonical) {
        summary.duplicateCount += 1;
        continue;
      }
      summary.findingCount += 1;
      summary.types[finding.type] += 1;
      const at = finding.observedAt;
      if (at === null) continue;
      // Compared as instants: ISO strings only sort correctly for four-digit years.
      if (summary.firstObservedAt === null || Date.parse(at) < Date.parse(summary.firstObservedAt)) summary.firstObservedAt = at;
      if (summary.lastObservedAt === null || Date.parse(at) > Date.parse(summary.lastObservedAt)) summary.lastObservedAt = at;
    }
  }
  const cases = [...byCase.values()].sort(
    (a, b) => Number(a.caseId.slice(2)) - Number(b.caseId.slice(2)) || (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0),
  );
  return { cases, unassigned: { findingCount: unassigned } };
}
