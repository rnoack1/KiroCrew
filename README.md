# Recall-history evidence

Media for the `fix(chat): recall a prompt whose send never reached the transcript`
pull request. This branch is an **orphan** — no parent, no code, not part of the
PR, and it never merges. It exists only to host these files for download.

Both arms were produced by the committed capture harness
(`website/scripts/capture-recall-history.mjs` + `website/capture/recall-history-after-lost-send.*`),
which mounts the real chat page and stubs only the network:

* `POST /api/chat` is left pending forever, so the send aborts the way a dead
  connection makes it abort.
* the slot refetch returns the original transcript, without the submitted prompt,
  because the server never received it.

Every claim in the frames is asserted against the DOM, not merely photographed;
each run exits non-zero if any assertion fails.

| File | Arm | Shows |
| ---- | --- | ----- |
| `before.gif` | pre-fix | first ↑ returns the older prompt; the lost one stays unreachable after 8 presses |
| `after.gif` | post-fix | first ↑ returns the lost prompt; the second reaches the older one |
| `05-prefix-first-arrowup.png` | pre-fix | composer after the first ↑ — the wrong prompt, 0 submissions recorded |
| `05-fixed-first-arrowup.png` | post-fix | composer after the first ↑ — the recovered prompt, 1 submission recorded |

The two stills are the same beat of the same scenario, so they differ only in the
composer value and the recorded count.
