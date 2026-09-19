# Rendered evidence — recall a prompt whose send never reached the transcript

This branch hosts rendered evidence referenced from a pull request description. It
carries no product source and is not intended to be merged.

## What each file shows

| File | What it shows |
| --- | --- |
| `before.gif` | Baseline: the lost prompt is unrecoverable; the first Up-Arrow yields the earlier prompt. |
| `after.gif` | Fixed: the first Up-Arrow recovers the lost prompt. |
| `verify-before-strip.png` | Baseline run, six asserted checkpoints with the per-checkpoint state. |
| `verify-after-strip.png` | Fixed run, the same six checkpoints. |
| `pane-before-first-arrowup.png` | Baseline: the grid pane's Up-Arrow recovers nothing. |
| `pane-after-first-arrowup.png` | Fixed: the grid pane's Up-Arrow recovers the lost prompt. |
| `build_recall_strip.py` | Builds the two strips from a run's screenshots. Included so the strips are reproducible. |

## How they were produced

Both recordings come from the capture entry committed on the fix branch, driven by
its committed script. Only the network is simulated, at two seams: the send POST is
left pending forever, so it ends in a real browser AbortError raised by the send's
own controller; and slot-detail answers the original transcript, because a server
that never received the POST holds no row for it. Every state claim in the strips is
asserted against the DOM by that script, which exits non-zero if an assertion fails.
Each run reported 19 passing assertions.

The two runs used a byte-identical capture entry, in two checkouts:

| | branch state | first Up-Arrow |
| --- | --- | --- |
| `after` | the fix branch head | returns the lost prompt |
| `before` | an ancestor of that head, with the fix absent | returns the earlier prompt; the lost one stays unreachable across eight presses |

The strips are built from the capture script's own numbered screenshots, each taken
at a checkpoint the script asserted, so a band label names a verified state rather
than a timestamp inferred afterwards. They are not frames sampled out of the GIF.

The grid-pane stills come from a separate entry mounting the pane component instead
of the full page; its `before` variant is a one-line reversion of the prop that
carries recall into the pane, restored byte-identically afterwards.

The pane entry and its driver are not committed on the fix branch: the committed
harness covers the single-chat composer, and these exist to photograph the pane for
review. `build_recall_strip.py` is included here for the same reason.
