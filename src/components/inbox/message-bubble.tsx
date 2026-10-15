'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import type { Message, MessageReaction } from '@/types';
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
} from 'lucide-react';
import { format } from 'date-fns';
import { ReplyQuote } from './reply-quote';
import { MessageReactions } from './message-reactions';

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

function StatusIcon({ status }: { status: Message['status'] }) {
  switch (status) {
    case 'sending':
      return <Clock className="text-muted-foreground h-3 w-3" />;
    case 'sent':
      return <Check className="text-muted-foreground h-3 w-3" />;
    case 'delivered':
      return <CheckCheck className="text-muted-foreground h-3 w-3" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case 'failed':
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
      <ImageOff className="text-muted-foreground h-4 w-4 shrink-0" />
      <span>{label} unavailable</span>
    </div>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith('/api/whatsapp/media/')) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load media');
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith('blob:')) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
        <ImageOff className="text-muted-foreground h-8 w-8" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
        <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }

  return (
    <Image
      unoptimized
      width={240}
      height={256}
      style={{ width: 'auto', height: 'auto' }}
      src={src ?? ''}
      alt={alt}
      className="max-h-64 max-w-60 rounded-lg object-cover"
      onError={() => setError(true)}
    />
  );
}

// ------------------------------------------------------------------
// [REFATORAÇÃO - MESSAGE CONTENT SUPORTE A CONTRASTE]:
// Recebe 'onPrimary' para ajustar dinamicamente as cores de badges e textos
// de apoio, impedindo que textos de templates fiquem pretos ou da mesma cor do fundo.
// ------------------------------------------------------------------
function outboundPaymentCta(
  message: Message
): { body: string; url: string; label: string } | null {
  if (message.sender_type === 'customer') return null;
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const payload = record(message.interactive_payload);
  const body = record(payload.body);
  const action = record(payload.action);
  const parameters = record(action.parameters);
  if (
    payload.type !== 'cta_url' ||
    action.name !== 'cta_url' ||
    typeof body.text !== 'string' ||
    typeof parameters.url !== 'string' ||
    typeof parameters.display_text !== 'string'
  )
    return null;
  if (
    !body.text.trim() ||
    !parameters.display_text.trim() ||
    parameters.display_text.length > 20 ||
    !/^https:\/\//i.test(parameters.url) ||
    /[\s\u0000-\u001f\u007f]/.test(parameters.url)
  )
    return null;
  try {
    const url = new URL(parameters.url);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
  } catch {
    return null;
  }
  return {
    body: body.text,
    url: parameters.url,
    label: parameters.display_text,
  };
}

function MessageContent({
  message,
  onPrimary,
}: {
  message: Message;
  onPrimary: boolean;
}) {
  switch (message.content_type) {
    case 'text':
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text || '[Mensagem de texto vazia]'}
        </p>
      );

    case 'image':
      return (
        <div>
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Shared image" />
          ) : (
            <MediaUnavailable label="Image" />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case 'video':
      return (
        <div>
          {message.media_url ? (
            <video
              src={message.media_url}
              controls
              className="max-h-64 max-w-60 rounded-lg"
            />
          ) : (
            <MediaUnavailable label="Video" />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case 'audio':
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label="Audio" />
          )}
        </div>
      );

    case 'document':
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || 'Document'} />;
      }
      return (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-muted/50 hover:bg-muted flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
        >
          <FileText className="text-muted-foreground h-5 w-5 shrink-0" />
          <span className="truncate">{message.content_text || 'Document'}</span>
        </a>
      );

    case 'template':
      return (
        <div>
          {/* Se estiver no balão do agente (onPrimary), renderiza com contraste branco suave. Se for do cliente, usa o tom primário da marca */}
          <span
            className={cn(
              'mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
              onPrimary
                ? 'bg-white/20 text-white'
                : 'bg-primary/10 text-primary'
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            Template: {message.template_name || 'Campanha'}
          </span>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap">
            {message.content_text || '[Template disparado com sucesso]'}
          </p>
        </div>
      );

    case 'location':
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="text-muted-foreground h-4 w-4 shrink-0" />
          <span>{message.content_text || 'Location shared'}</span>
        </div>
      );

    case 'interactive': {
      const cta = outboundPaymentCta(message);
      if (cta) {
        return (
          <div className="flex flex-col gap-2">
            <p className="text-sm break-words whitespace-pre-wrap">
              {cta.body}
            </p>
            <a
              href={cta.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-lg border border-current/30 px-3 py-2 text-sm font-medium hover:bg-white/10"
            >
              {cta.label}
            </a>
          </div>
        );
      }
      return (
        <div className="flex flex-col gap-0.5">
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase',
              onPrimary ? 'text-primary-foreground/75' : 'text-muted-foreground'
            )}
          >
            {!onPrimary && <CornerDownLeft className="h-3 w-3" />}
            {onPrimary ? 'Mensagem Interativa' : 'Resposta de Botão'}
          </span>
          <p className="text-sm break-words whitespace-pre-wrap">
            {message.content_text || '[Resposta Interativa]'}
          </p>
        </div>
      );
    }

    default:
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text || '[Tipo de mensagem não suportado]'}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const time = format(new Date(message.created_at), 'HH:mm');

  return (
    <div className={cn('flex flex-col', isAgent ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'relative rounded-2xl px-3 py-2',
          isAgent
            ? 'bg-primary text-primary-foreground rounded-br-md'
            : 'bg-muted text-foreground rounded-bl-md'
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        {/* Passamos isAgent como onPrimary para guiar as cores internas */}
        <MessageContent message={message} onPrimary={isAgent} />
        <div
          className={cn(
            'mt-1 flex items-center gap-1',
            isAgent ? 'justify-end' : 'justify-start'
          )}
        >
          <span
            className={cn(
              'text-[10px]',
              isAgent ? 'text-primary-foreground/70' : 'text-muted-foreground'
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
