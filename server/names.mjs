// Usernames: readable, unique, and impossible to impersonate with lookalike characters.
const FOLD = { '0': 'o', '1': 'l', 'i': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '$': 's', '@': 'a' };

export function foldName(name) {
  return [...name.normalize('NFKC').toLowerCase()]
    .filter(c => c !== '_' && c !== '.' && c !== '-')
    .map(c => FOLD[c] ?? c).join('');
}

const RESERVED = ['admin', 'support', 'predmon', 'official', 'moderator', 'team'].map(foldName);

/** Returns a clean name or throws a readable error. */
export function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new Error('Use 3-20 letters, numbers or underscores.');
  const folded = foldName(name);
  if (folded.length < 3) throw new Error('Pick a more distinctive name.');
  if (RESERVED.some(w => folded.startsWith(w))) throw new Error('That name is reserved.');
  return { name, folded };
}
