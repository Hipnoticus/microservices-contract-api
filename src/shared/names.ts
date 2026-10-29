/** Portuguese name particles that stay lower case inside a name ("Henrique de Azevêdo"). */
const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e', "d'"]);

/**
 * A person's name as it is written in messages: every word starts with a capital letter ("gabriel" -> "Gabriel",
 * "MARIA DA SILVA" -> "Maria da Silva"). Particles stay lower case except as the first word.
 */
export function properName(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return s.toLocaleLowerCase('pt-BR').split(' ').map((w, i) => {
    if (i > 0 && PARTICLES.has(w)) return w;
    // Hyphenated names: "ana-clara" -> "Ana-Clara"
    return w.split('-').map((p) => p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1)).join('-');
  }).join(' ');
}
