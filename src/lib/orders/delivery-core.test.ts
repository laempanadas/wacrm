import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import cardapio from '../../../assets/js/cardapio.json';

const skillPath = '.hermes/skills/delivery-core.md';

describe('permanent delivery project rules', () => {
  it('requires every project agent to read the delivery rules before edits', () => {
    const instructions = readFileSync('AGENTS.md', 'utf8');
    expect(instructions).toContain(skillPath);
    expect(instructions).toContain('antes de qualquer alteração');
    expect(instructions).toContain('BEGIN:nextjs-agent-rules');
  });

  it('keeps the project skill in versionable source rather than a local profile', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it.each(cardapio.itens)(
    'documents the exact official price and ID: $nome',
    (item) => {
      expect(existsSync(skillPath)).toBe(true);
      const skill = readFileSync(skillPath, 'utf8');
      expect(skill).toContain(
        `| ${item.id} | ${item.nome} | R$ ${item.preco.toFixed(2).replace('.', ',')} |`
      );
    }
  );

  it('documents free delivery, three channels, priority and payment safeguards', () => {
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, 'utf8');
    for (const required of [
      'Frete Grátis = R$ 0,00',
      'Site',
      'Catálogo Meta',
      'Texto Livre 50+',
      '+ 1 empanada frango',
      'Intenção de pedido sempre tem prioridade sobre pausas de atendente',
      '[TOTAL:xxx.xx]',
      '042_order_intent_priority.sql',
      '.env.local',
    ])
      expect(skill).toContain(required);
  });
});
