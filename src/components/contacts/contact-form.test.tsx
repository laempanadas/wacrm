import type { DependencyList, EffectCallback, SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactTag } from '@/types';

// Exercise the form's hook lifecycle without a browser or remote services.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  dependencies: [] as (DependencyList | undefined)[],
  effects: [] as EffectCallback[],
  cursor: 0,
  from: vi.fn(),
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const changed = (index: number, deps?: DependencyList) => {
    const previous = hooks.dependencies[index];
    hooks.dependencies[index] = deps;
    return (
      !previous ||
      !deps ||
      deps.some((value, i) => !Object.is(value, previous[i]))
    );
  };
  return {
    ...actual,
    useState: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [
        hooks.values[index],
        (value: SetStateAction<T>) => {
          hooks.values[index] =
            typeof value === 'function'
              ? (value as (previous: T) => T)(hooks.values[index] as T)
              : value;
        },
      ];
    },
    useEffect: (effect: EffectCallback, deps?: DependencyList) => {
      if (changed(hooks.cursor++, deps)) hooks.effects.push(effect);
    },
    useCallback: <T,>(callback: T, deps: DependencyList) => {
      const index = hooks.cursor++;
      if (changed(index, deps)) hooks.values[index] = callback;
      return hooks.values[index];
    },
  };
});
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => client,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'account-1' }),
}));
const client = { from: hooks.from };

import { ContactForm } from './contact-form';

const onOpenChange = vi.fn();
const onSaved = vi.fn();
function render(contactTags?: ContactTag[]) {
  hooks.cursor = 0;
  ContactForm({ open: true, onOpenChange, onSaved, contactTags });
  hooks.effects.splice(0).forEach((effect) => effect());
}

describe('ContactForm initialization dependencies', () => {
  beforeEach(() => {
    hooks.values = [];
    hooks.dependencies = [];
    hooks.effects = [];
    hooks.from.mockReturnValue({
      select: () => ({ order: async () => ({ data: [] }) }),
    });
  });

  it('updates selected tags when contact tags arrive while the form is open', () => {
    render([]);
    render([{ id: 'link-1', contact_id: 'contact-1', tag_id: 'tag-1' }]);
    expect(hooks.values).toContainEqual(['tag-1']);
  });

  it('does not repeatedly fetch when optional tags are omitted', () => {
    render();
    render();
    render();
    expect(hooks.from).toHaveBeenCalledTimes(1);
  });
});
