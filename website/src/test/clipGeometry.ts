/**
 * Clipped-message geometry for the inline `ErrorNotice` disclosure.
 *
 * The disclosure (dotted underline, tab stop, popover) is gated on MEASURED
 * overflow rather than on the presence of a `line-clamp-*` class, so a short
 * message in a wide row is not offered a reveal of text that is already fully
 * visible. jsdom performs no layout: `scrollHeight` and `clientHeight` are both
 * 0, so every message measures as NOT clipped. That default is the honest one
 * and is what the no-affordance test relies on — a test that needs the CLIPPED
 * branch has to ask for it, which is what this provides.
 *
 * Patches the prototype rather than one element because the component measures
 * in a mount effect, before a test can reach the node.
 */
const undoStack: (() => void)[] = []

/** Make every element report vertical overflow until {@link restoreClipGeometry}. */
export function stubMessageClipped(): void {
  const sizes: [keyof HTMLElement & string, number][] = [['scrollHeight', 48], ['clientHeight', 16]]
  for (const [prop, value] of sizes) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value })
    undoStack.push(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, prop, original)
      else Reflect.deleteProperty(HTMLElement.prototype, prop)
    })
  }
}

/** Undo {@link stubMessageClipped}. Safe to call when nothing was stubbed. */
export function restoreClipGeometry(): void {
  while (undoStack.length) undoStack.pop()!()
}
