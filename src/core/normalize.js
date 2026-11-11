import { isIP } from 'node:net';

export const FLAGS = [
  'id_missing',
  'duplicate_id',
  'reingested_duplicate',
  'entity_missing',
  'type_mismatch',
  'case_missing',
  'case_invalid',
  'multi_case',
  'time_invalid',
  'source_missing',
  'source_unsafe',
  'source_scheme_assumed',
  'source_invalid',
  'notes_missing',
  'notes_markup',
  'notes_instruction_like',
];

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const EMAIL = /^[^\s@]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i;
const LABEL_SYNONYMS = { ipv4: 'ip', ipv6: 'ip' };
// Types that have no checkable syntax, so the label is the only evidence and is trusted.
const LABEL_ONLY_TYPES = ['handle', 'alias', 'wallet'];

/**
 * The type a value provably has from its syntax alone. Handles and aliases have no syntax, and
 * only EVM wallets are recognised.
 * @param {string} entity already trimmed
 * @returns {'wallet' | 'ip' | 'email' | 'domain' | null}
 */
export function detectShape(entity) {
  if (WALLET.test(entity)) return 'wallet';
  if (isIP(entity) !== 0) return 'ip';
  if (EMAIL.test(entity)) return 'email';
  if (DOMAIN.test(entity) && entity.length <= 253) return 'domain';
  return null;
}

/**
 * The value's shape wins over the label, so that filtering by type finds every IP, email, etc.
 * The disagreement is reported, not hidden.
 * @param {string} typeRaw the label as collected ('' if absent)
 * @param {string} entity already trimmed
 * @returns {{ type: string, mismatch: boolean }}
 */
export function normalizeType(typeRaw, entity) {
  if (entity === '') return { type: 'unknown', mismatch: false };
  const trimmed = typeRaw.trim().toLowerCase();
  const label = LABEL_SYNONYMS[trimmed] ?? trimmed;
  const shape = detectShape(entity);
  if (shape !== null) return { type: shape, mismatch: label !== shape };
  if (LABEL_ONLY_TYPES.includes(label)) return { type: label, mismatch: false };
  return { type: 'unknown', mismatch: label !== 'unknown' };
}
