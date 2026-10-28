/** Only whole, explicitly supported kitchen instructions may bypass review. */
export function classifyNote(text: string): 'safe' | 'review' {
  const note = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:(?:bem|mal) passadas?|ao ponto|sem (?:cebola|azeitona|ovo|pimenta)|cortada ao meio|bem assada)$/.test(note)
    ? 'safe'
    : 'review';
}
