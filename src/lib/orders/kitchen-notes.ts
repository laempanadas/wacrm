/** Only whole, explicitly supported kitchen instructions may bypass review. */
export function classifyNote(text: string): 'safe' | 'review' {
  const note = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:(?:bem|mal) passadas?|ao ponto|sem (?:cebola|azeitona|ovo|pimenta)|cortada ao meio|bem assada)$/.test(
    note
  )
    ? 'safe'
    : 'review';
}

/** Stored item notes may contain several independently allowed lines. */
export function classifyItemNotes(text: string): 'safe' | 'review' {
  return text.split(/\r?\n/).every((line) => classifyNote(line) === 'safe')
    ? 'safe'
    : 'review';
}

/** Keep existing instructions (including review text); never overwrite them. */
export function appendKitchenNotes(
  notes: string | undefined,
  extra: readonly string[]
): string {
  const known = new Set((notes ?? '').split(/\r?\n/));
  const parts = notes ? [notes] : [];
  for (const line of extra) {
    if (!known.has(line)) {
      parts.push(line);
      known.add(line);
    }
  }
  return parts.join('\n');
}
