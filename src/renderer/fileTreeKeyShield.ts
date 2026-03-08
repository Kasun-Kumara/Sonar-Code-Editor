/**
 * ── FileTree Input Keyboard Shield ──────────────────────────────────────
 *
 * PROBLEM: Monaco Editor registers global capture-phase keydown listeners that
 * call preventDefault() on printable characters when it thinks it owns focus
 * (e.g. after a tab/file close).  preventDefault() on keydown stops the
 * keypress event from firing, which prevents the browser from inserting
 * characters.  Delete/Backspace don't rely on keypress, so they still work.
 *
 * FIX: Register our own capture-phase listeners BEFORE Monaco (by importing
 * this module first in main.tsx).  For FileTree inputs we call
 * stopImmediatePropagation() so Monaco never sees the event — but we do NOT
 * call preventDefault(), so the browser inserts characters normally.
 *
 * React's onChange for <input> is driven by the 'input' event (not keydown),
 * so blocking keydown propagation does not break React's controlled inputs.
 * Enter/Escape are handled via a callback registry since React's onKeyDown
 * won't fire.
 */

export const fileTreeInputCallbacks = new WeakMap<
  HTMLElement,
  { onSubmit: () => void; onCancel: () => void }
>();

function isFileTreeInput(el: EventTarget | null): el is HTMLInputElement {
  return (
    el instanceof HTMLElement &&
    el.tagName === "INPUT" &&
    (el.classList.contains("rename-input") ||
      el.classList.contains("inline-create-input"))
  );
}

if (typeof window !== "undefined") {
  // ── keydown capture ──────────────────────────────────────────────────
  // Runs before Monaco's capture listener.  Block Monaco, let browser act.
  window.addEventListener(
    "keydown",
    (e) => {
      // ONLY check e.target — never document.activeElement.  Checking
      // activeElement caused the shield to hijack events in the Monaco
      // editor whenever a rename input existed anywhere in the DOM.
      if (!isFileTreeInput(e.target)) return;

      const input = e.target as HTMLInputElement;

      // Block Monaco from seeing this event
      e.stopImmediatePropagation();

      // Enter / Escape need special handling since React's onKeyDown
      // won't fire (we killed propagation).  Use the callback registry.
      if (e.key === "Enter") {
        e.preventDefault();
        fileTreeInputCallbacks.get(input)?.onSubmit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        fileTreeInputCallbacks.get(input)?.onCancel();
        return;
      }

      // For ALL other keys: do NOT call preventDefault().
      // The browser will proceed: keypress → beforeinput → insert char → input event → React onChange.
    },
    true,
  );

  // ── keypress capture ─────────────────────────────────────────────────
  // Monaco may also have a keypress capture listener.  Block it.
  // Do NOT preventDefault — we need the browser to insert the character.
  window.addEventListener(
    "keypress",
    (e) => {
      if (!isFileTreeInput(e.target)) return;
      e.stopImmediatePropagation();
    },
    true,
  );

  // ── beforeinput capture ──────────────────────────────────────────────
  window.addEventListener(
    "beforeinput",
    (e) => {
      if (!isFileTreeInput(e.target)) return;
      e.stopImmediatePropagation();
    },
    true,
  );
}
