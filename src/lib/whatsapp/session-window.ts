const SESSION_MS = 24 * 60 * 60 * 1000;

/** Only a customer inbound opens the WhatsApp free-form messaging window. */
export function sessionWindow(
  lastInboundAt: string | null | undefined,
  now = Date.now()
): { expired: boolean; remaining: string } {
  const inbound = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  if (!Number.isFinite(inbound) || !Number.isFinite(now) || inbound > now) {
    return { expired: true, remaining: 'No customer messages' };
  }
  const remainingMs = inbound + SESSION_MS - now;
  if (remainingMs <= 0) return { expired: true, remaining: 'Expired' };
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  return {
    expired: false,
    remaining:
      hours >= 1
        ? `${hours}h remaining`
        : `${Math.ceil(remainingMs / 60000)}m remaining`,
  };
}
