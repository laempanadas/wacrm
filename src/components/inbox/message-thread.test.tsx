import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Contact, Message } from '@/types';

const clock = vi.hoisted(() => ({ now: Date.parse('2026-10-18T12:00:00Z') }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'agent' } }),
}));
vi.mock('@/hooks/use-presence', () => ({
  usePresence: () => ({
    now: clock.now,
    getPresence: () => 'offline',
    getRow: () => undefined,
  }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('No network during render');
  },
}));
vi.mock('./message-composer', () => ({
  CHAT_MEDIA_BUCKET: 'chat',
  MessageComposer: ({ sessionExpired }: { sessionExpired: boolean }) => (
    <div data-session-expired={String(sessionExpired)} />
  ),
}));
vi.mock('./template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('./message-bubble', () => ({ MessageBubble: () => null }));
vi.mock('./message-actions', () => ({ MessageActions: () => null }));
import { MessageThread } from './message-thread';

const conversation = {
  id: 'conversation',
  status: 'open',
  unread_count: 0,
  last_message_at: '2026-10-18T12:00:00Z',
} as Conversation;
const contact = {
  id: 'contact',
  name: 'Maria',
  phone: '5511999999999',
} as Contact;
const noop = () => undefined;
function render(messages: Message[]) {
  return renderToStaticMarkup(
    <MessageThread
      conversation={conversation}
      contact={contact}
      messages={messages}
      onMessagesLoaded={noop}
      onNewMessage={noop}
      onUpdateMessage={noop}
      onStatusChange={noop}
      onAssignChange={noop}
    />
  );
}
function message(
  sender_type: Message['sender_type'],
  created_at: string
): Message {
  return {
    id: `${sender_type}:${created_at}`,
    conversation_id: 'conversation',
    sender_type,
    created_at,
    content_type: 'text',
    content_text: 'Hi',
    status: 'delivered',
  };
}
describe('MessageThread customer-session composer gate', () => {
  it('blocks empty history and outbound-only history', () => {
    expect(render([])).toContain('data-session-expired="true"');
    expect(render([message('agent', '2026-10-18T12:00:00Z')])).toContain(
      'data-session-expired="true"'
    );
  });
  it('expires on a clock tick without new messages, to the millisecond', () => {
    const messages = [message('customer', '2026-10-17T12:00:01Z')];
    clock.now = Date.parse('2026-10-18T12:00:00Z');
    expect(render(messages)).toContain('data-session-expired="false"');
    expect(render(messages)).toContain('1m remaining');
    clock.now += 1000;
    expect(render(messages)).toContain('data-session-expired="true"');
  });
  it('uses newest inbound even with unsorted history and newer outbound', () => {
    clock.now = Date.parse('2026-10-18T12:00:00Z');
    expect(
      render([
        message('customer', '2026-10-18T11:00:00Z'),
        message('agent', '2026-10-18T12:00:00Z'),
        message('customer', '2026-10-16T12:00:00Z'),
      ])
    ).toContain('data-session-expired="false"');
  });
});
