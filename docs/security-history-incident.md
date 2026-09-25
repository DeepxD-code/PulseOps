# Security history incident — action required

## Status

This is an unresolved release blocker. Do not publish or push a branch containing
old session artifacts until the credentials below have been rotated and the
artifact history has been assessed.

A local backup branch (`laptop-wip`) contains a historical
`apps/browser-apply/storageState.json` object. The current safety branch does
not track `.env`, `portal/storageState.json`, or a secrets tarball, but Git
objects and backup refs can retain old material after files are deleted.

## Required before release

1. Rotate/revoke the Gmail App Password and IMAP credentials.
2. Revoke and recreate Discord webhook URLs, including the G10 review webhook.
3. Rotate Telegram bot tokens, Gemini/Groq/OpenAI keys, SearchAPI/TheirStack
   keys, GitHub tokens, and any SMTP credentials that were ever stored in the
   repository or tarball.
4. Revoke active browser sessions for Naukri, LinkedIn, Wellfound, and YC.
5. Audit the remote repository and all backup/reflog refs for the artifact
   paths. If present remotely, use an approved history-rewrite procedure
   (`git filter-repo`/BFG), coordinate force-pushes, and require collaborators
   to reclone.
6. Delete local backup refs only after preserving any needed non-secret code;
   never merge `laptop-wip` or push it as-is.
7. Re-run secret scanning and verify that no live `.env`, storage-state JSON,
   key, or archive is tracked.

## Verification

Run from the repository root:

```powershell
git ls-files | Select-String -Pattern '(^|/)(\\.env|.*storageState.*|.*\\.enc|.*\\.key|.*\\.pem|.*\\.tar\\.gz|.*\\.tgz)$'
git rev-list --objects --all | Select-String -Pattern '(storageState|\\.env$|\\.tar\\.gz$|\\.tgz$)'
```

An empty result is necessary but not sufficient: remote servers, Git reflogs,
and deleted backup refs must also be checked.
