import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  getMediaUrl,
  downloadMediaStream,
  MediaFetchError,
} from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

function privateJson(body: { error: string }, init: { status: number }) {
  return NextResponse.json(body, { ...init, headers: PRIVATE_HEADERS });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params;

    if (!/^\d+$/.test(mediaId)) {
      return privateJson(
        { error: 'A numeric Media ID is required' },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return privateJson({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return privateJson(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    // The session-bound client preserves RLS. Never proxy an arbitrary
    // Meta ID just because the caller has access to an account token.
    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select('id, conversations!inner(account_id)')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      .eq('conversations.account_id', accountId)
      .limit(1)
      .maybeSingle();
    if (messageError || !message) {
      return privateJson({ error: 'Media not found' }, { status: 404 });
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('access_token, phone_number_id')
      .eq('account_id', accountId)
      .single();

    if (configError || !config || !config.phone_number_id) {
      return privateJson({ error: 'WhatsApp not configured' }, { status: 409 });
    }

    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
      if (!accessToken || /\s/.test(accessToken)) throw new Error();
    } catch {
      return privateJson(
        { error: 'WhatsApp credentials cannot be read. Reconnect WhatsApp.' },
        { status: 422 }
      );
    }

    // Meta URLs are short-lived. Only a download 404 warrants resolving a
    // fresh URL once; never retry metadata failures, credentials or redirects.
    const download = async () => {
      const mediaInfo = await getMediaUrl({
        mediaId,
        accessToken,
        phoneNumberId: config.phone_number_id,
      });
      return downloadMediaStream({
        downloadUrl: mediaInfo.url,
        accessToken,
        mimeType: mediaInfo.mimeType,
      });
    };
    let media;
    try {
      media = await download();
    } catch (error) {
      if (!(error instanceof MediaFetchError) || error.upstreamStatus !== 404)
        throw error;
      media = await download();
    }
    const { body, contentType } = media;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof MediaFetchError) {
      return privateJson({ error: error.message }, { status: error.status });
    }
    return privateJson({ error: 'Failed to fetch media' }, { status: 500 });
  }
}
