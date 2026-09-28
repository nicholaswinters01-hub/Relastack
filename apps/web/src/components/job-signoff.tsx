'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type PointerEvent } from 'react';
import type { JobSignoff as Signoff } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

const WIDTH = 600;
const HEIGHT = 200;

/**
 * The customer signs on the tech's phone with a finger.
 *
 * Drawn on a canvas and sent as a PNG. A signature is never changed; signing
 * again adds a new one, and the latest is shown.
 */
export function JobSignoff({
  jobId,
  signoff,
  canSign,
  defaultName,
}: {
  jobId: string;
  signoff: Signoff | null;
  canSign: boolean;
  defaultName: string;
}) {
  const router = useRouter();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [hasInk, setHasInk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * WIDTH,
      y: ((event.clientY - box.top) / box.height) * HEIGHT,
    };
  };

  function start(event: PointerEvent<HTMLCanvasElement>) {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some browsers refuse capture for synthetic pointers; drawing still works.
    }
    drawing.current = true;
    const { x, y } = point(event);
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.strokeStyle = '#111827';
    context.beginPath();
    context.moveTo(x, y);
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const { x, y } = point(event);
    context.lineTo(x, y);
    context.stroke();
    setHasInk(true);
  }

  function clear() {
    const context = canvas.current?.getContext('2d');
    context?.clearRect(0, 0, WIDTH, HEIGHT);
    setHasInk(false);
  }

  async function save() {
    if (!canvas.current || !hasInk) {
      setError('Sign in the box first.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await apiWrite(`/api/v1/jobs/${jobId}/signoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signerName: name, image: canvas.current.toDataURL('image/png') }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }
      setOpen(false);
      clear();
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <h2 className="text-sm font-semibold">Customer sign-off</h2>
      {signoff ? (
        <div className="mt-2">
          {/* A data URL the API checked is a PNG; allowed by the page's img-src. */}
          <img
            src={signoff.image}
            alt={`Signature of ${signoff.signerName}`}
            className="h-24 rounded-lg border border-[var(--color-line)] bg-white"
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Signed by {signoff.signerName} ·{' '}
            {new Date(signoff.signedAt).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}{' '}
            · taken by {signoff.recordedByName}
          </p>
        </div>
      ) : (
        <p className="mt-1 text-sm text-[var(--color-muted)]">Not signed yet.</p>
      )}

      {canSign && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 text-sm underline underline-offset-4"
        >
          {signoff ? 'Sign again' : 'Take a signature'}
        </button>
      )}

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Name of the person signing
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
              maxLength={120}
            />
          </label>
          <canvas
            ref={canvas}
            width={WIDTH}
            height={HEIGHT}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={() => (drawing.current = false)}
            onPointerLeave={() => (drawing.current = false)}
            aria-label="Signature box: sign with your finger or mouse"
            className="w-full touch-none rounded-lg border border-[var(--color-line)] bg-white"
            style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
          />
          {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !name.trim()}
              className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save signature'}
            </button>
            <button
              type="button"
              onClick={clear}
              className="px-3 text-sm underline underline-offset-4"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 text-sm underline underline-offset-4"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
