'use client';

/** Opens the browser's print dialog, where "Save as PDF" also lives. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg bg-black px-3 py-2 text-sm font-medium text-white"
    >
      Print or save as PDF
    </button>
  );
}
