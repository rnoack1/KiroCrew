# Rendered evidence — recall a prompt whose send never reached the transcript

This branch hosts rendered evidence referenced from a pull request description, and
the harness that produced it. It carries no product source and is not intended to be
merged.

## What each file shows

| File | What it shows |
| --- | --- |
| `before.gif` | Baseline: the lost prompt is unrecoverable; the first Up-Arrow yields the earlier prompt. |
| `after.gif` | Fixed: the first Up-Arrow recovers the lost prompt. |
| `verify-before-strip.png` | Baseline run, six asserted checkpoints with the per-checkpoint state. |
| `verify-after-strip.png` | Fixed run, the same six checkpoints. |
| `pane-before-first-arrowup.png` | Baseline: the grid pane's Up-Arrow recovers nothing. |
| `pane-after-first-arrowup.png` | Fixed: the grid pane's Up-Arrow recovers the lost prompt. |
| `build_recall_strip.py` | Builds the two strips from a run's screenshots. |
| `harness/recall-history-after-lost-send.tsx` | The capture entry: mounts the real page and stages the lost send. |
| `harness/recall-history-after-lost-send.html` | Its document shell. |
| `harness/capture-recall-history.mjs` | The driver: runs the entry, asserts each checkpoint, writes the webm and screenshots. |

## Where the harness lives, and why it is here

**The harness is on this branch rather than on the fix branch.** It was committed
there through several revisions; it was moved here when the fix itself needed the
line budget the harness was occupying (536 added lines, 38% of that diff), and
because a first-principles review had already identified it as verification tooling
riding along with a behavioural fix rather than part of it.

Nothing about the recordings changed in the move: they were produced by these exact
files, and re-running them reproduces the recordings from here. To do that, copy
`harness/recall-history-after-lost-send.{tsx,html}` into `website/capture/` and
`harness/capture-recall-history.mjs` into `website/scripts/` of a checkout, then:

```
cd website && npx vite --host 127.0.0.1 --port 6879 --strictPort
node scripts/capture-recall-history.mjs http://127.0.0.1:6879 <outDir> --mode fixed
```

`--mode prefix` drives the baseline arm. The entry deliberately does not import the
fix's helper and reads the store slice with optional chaining, so the same file runs
unchanged in a checkout without the fix — a before/after pair proves nothing if the
two runs differ.

## How they were produced

Only the network is simulated, at two seams: the send POST is left pending forever,
so it ends in a real browser AbortError raised by the send's own controller; and
slot-detail answers the original transcript, because a server that never received the
POST holds no row for it. Every state claim in the strips is asserted against the DOM
by the driver, which exits non-zero if an assertion fails. Each run reported 19
passing assertions.

The two runs used a byte-identical capture entry, in two checkouts:

| | branch state | first Up-Arrow |
| --- | --- | --- |
| `after` | the fix branch head | returns the lost prompt |
| `before` | an ancestor of that head, with the fix absent | returns the earlier prompt; the lost one stays unreachable across eight presses |

The strips are built from the driver's own numbered screenshots, each taken at a
checkpoint it asserted, so a band label names a verified state rather than a timestamp
inferred afterwards. They are not frames sampled out of the GIF.

The grid-pane stills come from a separate entry mounting the pane component instead
of the full page; its `before` variant is a one-line reversion of the prop that
carries recall into the pane, restored byte-identically afterwards. That pane entry is
not included here — it photographs the pane for review and is not part of either
recording.
