# Security history incident — action required

## Status

This is an unresolved release blocker. Do not publish or push a branch containing
old session artifacts until the credentials below have been rotated and the
artifact history has been assessed.

## Scope of the exposure

**The remote is clean of credentials and session state. It is NOT clean of the
operator's personal email address, which is published on `origin/main`.**

Two distinct things are in play, and conflating them is what made an earlier
revision of this document wrong in the other direction.

**1. Session artifacts and credentials — local only.** The local branch
`laptop-wip` was never pushed. All `origin/*` refs contain zero matches for
`storageState`, `.env`, `Login Data`, or `Network/Cookies` (verified with
`git ls-tree -r --name-only <ref>` against `origin/main`,
`origin/fix/live-automation-safety` and `origin/pulseops-state`: 0 sensitive
paths each). No history rewrite or force-push is needed for the remote.

**2. The operator's personal email — PUBLISHED on the default branch.** This is
not a credential, but it is PII, and it is live in tracked files:

```
origin/main:docs/archive/push_to_github.sh
origin/main:packages/pulse-notify/src/pulseops_notify/email_watcher.py
```

`origin/pulseops-state` is clean of it. The second file has since been changed
to read `SMTP_EMAIL` from the environment, but the address remains in the
committed history of `origin/main` and cannot be removed without a history
rewrite. Treat the address as public and do not rely on it being secret.

**Do not describe the remote as "clean" without naming which sense.** The
sentence that mattered most in this document was the reassuring one, and it was
too broad in exactly the direction that causes someone to skip the check.

The credential exposure itself is the local branch, and it is **much larger than
a single file**. An earlier revision described it as "a historical
`apps/browser-apply/storageState.json` object", which understated it by three
orders of magnitude. Verified counts on `laptop-wip`:

- **1137 tracked files total, of which 900 are a committed live Edge profile**
  (`.edge-profile/`) — not a build artifact, but a real browser profile.
- `.edge-profile/Default/Login Data` and `.edge-profile/Default/Login Data For
  Account` — saved logins, i.e. **credentials**, not merely session cookies.
- `.edge-profile/Default/Network/Cookies` — the complete cookie jar for every
  site visited in that profile, not just the four automation targets.
- `.edge-profile/Default/IndexedDB/https_www.linkedin.com_0.indexeddb.leveldb/`
  and the matching `https_www.naukri.com_0.indexeddb.*` stores — **LinkedIn and
  Naukri site data** (inbox contents, drafts, session-scoped app state).
- `.edge-profile/Local State`, `Default/Web Data`, `Default/History`.
- `apps/browser-apply/storageState.json` — a 92,225-byte (92 KB) storageState
  blob. This is real but is the *smallest* part of the problem.

An earlier revision of this document also implied a rotation had been recorded.
**No credential rotation is recorded anywhere in this repository.** The list
below is still entirely outstanding; nothing in it has been done.

## Outstanding: the branch purge

`laptop-wip` has **not** been deleted, and deleting it is deliberately left as
an explicit human decision — it is destructive, it destroys the only copy of any
unmerged work on that branch, and it is not a fix an automated pass should make
on the operator's behalf. Treat it as a required step, not an optional one:

1. Salvage first. Extract any non-secret work from `laptop-wip` onto a fresh
   branch. Note that `.edge-profile/` is secret material, not work product —
   there is nothing to salvage from it, and it must never be carried forward.
2. Then `git branch -D laptop-wip` locally.
3. Because the branch was never pushed, there is no remote to clean and no
   force-push to coordinate. Delete the local reflog for the branch afterwards
   (`git reflog expire --expire=now --all`) **only** as a deliberate follow-up —
   note that this also affects unrelated reflogs, so it is a separate decision.
4. Re-verify: `git rev-list --objects --all` should return no `.edge-profile/`
   paths, and the branch should no longer be listed in `git branch -a`.

The current safety branch does not track `.env`, `portal/storageState*.json`,
or a secrets tarball, but Git objects and backup refs can retain old material
after files are deleted.

## Required before release

**None of the following has been performed.** Treat every line as outstanding.

1. Rotate/revoke the Gmail App Password and IMAP credentials. Because
   `Login Data` was committed, treat every password *saved in the browser* as
   compromised, not just the SMTP app password.
2. Revoke and recreate Discord webhook URLs, including the G10 review webhook.
3. ~~Rotate Telegram bot tokens, Gemini/Groq/OpenAI keys, SearchAPI/TheirStack
   keys, GitHub tokens, and any SMTP credentials that were ever stored in the
   repository or tarball.~~ **Operator decision 2026-09-30: rotation declined.**
   Recorded here so it is not silently re-opened. The residual risk is accepted:
   `Login Data` on `laptop-wip` means passwords saved in that browser were
   exposed to anyone with the local repo, and rotating only the SMTP app
   password would leave the rest unchanged regardless. The live surface is
   limited — the remote has never held a credential or session artifact, so
   nothing was published to a third party. Reopening this requires the exposure
   to actually be used, not merely to exist.
4. Revoke active browser sessions for Naukri, LinkedIn, Wellfound, and YC.
5. Audit the remote repository and all backup/reflog refs for the artifact
   paths. **This has been done for `origin/*` and came back clean for
   credentials and session state** — 0 `storageState`/`.env`/`Login Data`/
   `Network/Cookies` paths on `origin/main`, `origin/fix/live-automation-safety`
   or `origin/pulseops-state`. Only the local `laptop-wip` ref carries that
   material.

   **The same audit against the operator's personal email returned a different
   answer**: it is present in `origin/main` and `origin/fix/live-automation-safety`
   (see Scope, item 2). If removing it from published history is wanted, that
   requires an approved history-rewrite procedure (`git filter-repo`/BFG), a
   coordinated force-push, and requiring collaborators to reclone. That is a
   separate, larger decision from the local purge, because unlike the session
   artifacts it *is* already public.
6. Delete local backup refs only after preserving any needed non-secret code;
   never merge `laptop-wip` or push it as-is. See "Outstanding: the branch
   purge" above for the ordered steps.
7. Re-run secret scanning and verify that no live `.env`, storage-state JSON,
   key, or archive is tracked. Note that `.gitignore` now covers
   `**/storageState*.json`, `**/*-storageState.json` and
   `apps/browser-apply/*storageState*.json`; the earlier rules anchored at the
   start of the filename and never matched `autter-storageState.json` or
   `naukri-storageState.json`, both of which hold live authenticated sessions.
8. Decide whether the published personal email warrants a history rewrite. If
   not, record that decision so the next reader does not re-open it.

## Verification

Run from the repository root:

```powershell
git ls-files | Select-String -Pattern '(^|/)(\\.env|.*storageState.*|.*\\.enc|.*\\.key|.*\\.pem|.*\\.tar\\.gz|.*\\.tgz)$'
git rev-list --objects --all | Select-String -Pattern '(storageState|\\.env$|\\.tar\\.gz$|\\.tgz$)'
```

An empty result is necessary but not sufficient: remote servers, Git reflogs,
and deleted backup refs must also be checked.
