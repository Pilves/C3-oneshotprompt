/**
 * Estonian/English term groups for the investigative vocabulary in this dataset. If a query term
 * starts with any stem in a group, every stem in the group is tried. Stems are folded (no
 * diacritics, lower case) because they are matched against folded text.
 */
export const GLOSSARY = [
  ['phish', 'ongits'],
  ['domain', 'domeen'],
  ['regist'], // registered / registreeriti share the stem
  ['incident', 'intsident', 'attack', 'runnak', 'runde'],
  ['user', 'kasutaja'],
  ['source', 'allika'],
  ['uncertain', 'unreliab', 'unverif', 'confidence', 'ebakind'],
  ['verif', 'check', 'kontroll'],
  ['encrypt', 'sifreeri', 'krupt'],
  ['file', 'fail'],
  ['log', 'journal', 'zurnaal'],
  ['login', 'sisselogi'],
  ['night', 'oosel', 'oine'],
  ['repeat', 'kordu'],
  ['message', 'sonum'],
  ['password', 'parool', 'salasona'],
  ['hash', 'rasi'],
  ['leak', 'lekki', 'leke'],
  ['campaign', 'kampaania'],
  ['address', 'aadress'],
  ['server'],
  ['wallet', 'rahakot'],
];
