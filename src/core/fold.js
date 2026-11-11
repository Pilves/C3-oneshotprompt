/**
 * Lower-cases and strips diacritics one code point at a time, remembering where every folded
 * UTF-16 unit came from, so a match found in folded text can be highlighted in the original.
 *
 * A match of folded units [a, b) covers the original range [starts[a], ends[b - 1]).
 * @param {string} str
 * @returns {{ text: string, starts: number[], ends: number[] }}
 */
export function fold(str) {
  let text = '';
  const starts = [];
  const ends = [];
  let i = 0;
  let previousUnits = 0;
  for (const cp of str) {
    const end = i + cp.length;
    const folded = cp.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    if (folded === '') {
      // A bare combining mark belongs to the character before it. Widening that character's range
      // keeps a highlight from separating a base letter from its accent in decomposed input.
      for (let k = ends.length - previousUnits; k < ends.length; k++) ends[k] = end;
    } else {
      for (let k = 0; k < folded.length; k++) {
        starts.push(i);
        ends.push(end);
      }
      text += folded;
      previousUnits = folded.length;
    }
    i = end;
  }
  return { text, starts, ends };
}

/** @param {string} str */
export function foldText(str) {
  return fold(str).text;
}
