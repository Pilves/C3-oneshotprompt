import { FLAGS, normalizeRecord } from './normalize.js';

/**
 * Turns the parsed findings file into findings with unique ids, plus a report of what was found.
 * Never fails on a bad record; only a file without a findings array is rejected.
 * @param {unknown} dataset `{ findings: [...] }` or a bare array
 */
export function ingest(dataset) {
  const records = Array.isArray(dataset) ? dataset : Array.isArray(dataset?.findings) ? dataset.findings : null;
  if (records === null) throw new Error('findings.json: expected an object with a "findings" array');

  const entries = [];
  records.forEach((raw, index) => {
    const entry = normalizeRecord(raw, index);
    if (entry !== null) entries.push(entry);
  });
  const findings = entries.map((entry) => entry.finding);

  assignUniqueIds(findings);
  linkDuplicates(entries);
  for (const finding of findings) finding.flags.sort((a, b) => FLAGS.indexOf(a) - FLAGS.indexOf(b));

  return { findings, report: buildReport(dataset, records.length, findings) };
}

/**
 * Lookups upper-case the requested id, so ids are compared without regard to letter case here too.
 * Every raw id is reserved first: a record keeps its own id unless another record has the same one.
 */
function assignUniqueIds(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = finding.rawId.toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  const taken = new Set(groups.keys());
  for (const group of groups.values()) {
    let n = 1;
    for (const finding of group.slice(1)) {
      do {
        n += 1;
      } while (taken.has(`${finding.rawId}-${n}`.toUpperCase()));
      finding.id = `${finding.rawId}-${n}`;
      taken.add(finding.id.toUpperCase());
    }
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const finding of group) {
      finding.flags.push('duplicate_id');
      finding.sameRawId = group.filter((other) => other !== finding).map((other) => other.id).sort();
    }
  }
}

/**
 * Records with different ids that describe the same observation. Records with no entity or no
 * valid time are left alone: too little remains to call two of them the same.
 */
function linkDuplicates(entries) {
  const groups = new Map();
  for (const { finding, entityKey, observedAtMs, dedupeKey } of entries) {
    if (entityKey === '' || observedAtMs === null) continue;
    const key = [entityKey, finding.caseIds.join(','), observedAtMs, dedupeKey, finding.notes.trim()].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [canonical, ...copies] = group.toSorted(compareCanonical);
    for (const copy of copies) {
      copy.duplicateOf = canonical.id;
      copy.flags.push('reingested_duplicate');
    }
    canonical.duplicates = copies.map((copy) => copy.id);
  }
}

/** The lowest id is the original: the data offers no other ordering (no import dates). */
function compareCanonical(a, b) {
  const na = numericPart(a.rawId);
  const nb = numericPart(b.rawId);
  if (na !== nb) {
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function numericPart(rawId) {
  const digits = /\d+/.exec(rawId);
  return digits === null ? null : Number(digits[0]);
}

function buildReport(dataset, recordCount, findings) {
  const declared = dataset?._meta?.count;
  const declaredCount = Number.isInteger(declared) ? declared : null;
  const flags = Object.fromEntries(FLAGS.map((flag) => [flag, 0]));
  for (const finding of findings) for (const flag of finding.flags) flags[flag] += 1;
  const canonical = findings.filter((finding) => finding.duplicateOf === null).length;
  return {
    records: recordCount,
    skipped: recordCount - findings.length,
    findings: findings.length,
    canonical,
    duplicates: findings.length - canonical,
    cases: new Set(findings.flatMap((finding) => finding.caseIds)).size,
    declaredCount,
    countMismatch: declaredCount !== null && declaredCount !== recordCount,
    flags,
  };
}
