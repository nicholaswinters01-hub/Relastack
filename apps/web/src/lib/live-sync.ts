/**
 * Keeping several RelaStack windows in step.
 *
 * Someone with the schedule on one monitor and a customer on the other expects
 * a change in either to show in both. Every write in the app goes through
 * `apiWrite`, which announces a successful change on a browser channel; every
 * other window of the same browser hears it and refreshes its data.
 *
 * Browser-only, and quiet when the channel is unavailable (old browsers,
 * some private modes): the app then behaves as it always did.
 */

const CHANNEL = 'relastack';

export type SyncMessage = { type: 'changed' } | { type: 'signed-out' };

function channel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

export function announce(message: SyncMessage): void {
  const bus = channel();
  if (!bus) return;
  bus.postMessage(message);
  bus.close();
}

export function listen(onMessage: (message: SyncMessage) => void): () => void {
  const bus = channel();
  if (!bus) return () => undefined;
  bus.onmessage = (event: MessageEvent<SyncMessage>) => onMessage(event.data);
  return () => bus.close();
}

/**
 * `fetch` for anything that changes data. Same arguments, same response; a
 * successful change is announced to the other windows. A failed one is not,
 * since nothing changed.
 */
export async function apiWrite(input: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(input, { credentials: 'include', ...init });
  if (response.ok) announce({ type: 'changed' });
  return response;
}
