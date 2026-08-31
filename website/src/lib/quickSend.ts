import { dispatchIsCommandShaped } from '../app-sdk/protocol/recommendation'

/** Determines if a follow-up option click should send immediately (Quick Send mode). */
export function shouldQuickSend(quickSend: boolean | undefined, shiftKey: boolean, slotRunning: boolean, pickedSize: number): boolean {
  return !!(quickSend && !shiftKey && !slotRunning && pickedSize === 0)
}

/** Attempts quick-send; returns true if sent, false if caller should fall through to multi-select. */
export function tryQuickSend(option: string, quickSend: boolean | undefined, shiftKey: boolean, slotRunning: boolean, pickedSize: number, send: (text: string) => void): boolean {
  // A chip that sends on ONE click must not dispatch a command. Nothing to do with the
  // recommendation, which no longer touches labels: a BARE `/clear` chip carries no marker
  // and one click ran it.
  if (dispatchIsCommandShaped(option)) return false
  if (shouldQuickSend(quickSend, shiftKey, slotRunning, pickedSize)) {
    send(option)
    return true
  }
  return false
}
