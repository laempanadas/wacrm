import type { Metadata } from 'next';
import { CardapioView } from '@/components/cardapio/cardapio-view';

export const metadata: Metadata = {
  title: 'Cardápio',
};

export default function CardapioPage() {
  return <CardapioView />;
}
