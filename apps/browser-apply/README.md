# browser-apply

Playwright auto-apply + LinkedIn outreach. Needs `portal/storageState.json`
(run `node save_sessions.mjs`, log in with email, press Enter).

## Scripts

- `npm run apply` — dry-run previews, no submits.
- `npm run apply:live` — fill + submit with saved session (`--live --headed --auto`).
- `npm run find -- --company "Acme"` — dry-run LinkedIn people finder for one company.
- `npm run find:live -- --all` — find people for queued jobs + send DMs + Discord @-tag.

## Resume vs CV

The upload control's own label decides which document is sent:

- **A form that asks for a resume** gets a resume built from `cv.md` for that job
  description (the row's stored bullet adjustments and tailored skills, via
  `tools/build_resume_for_job.py`), verified (real PDF, 1-2 pages, candidate's
  name and email present) and then uploaded. It is rebuilt whenever `cv.md` is
  newer than the rendered file.
- **A form that asks for a CV** gets the canonical CV untouched:
  `PULSEOPS_CV_PDF`, else `candidate.cv_pdf` in `config/profile.yml`, else
  `~/Documents/Job stuff/Avradeep-Majumder-cv.pdf`, else
  `output/Avradeep-Majumder-cv.pdf`.

"Resume/CV" counts as a resume request: the label does ask for one, and a
tailored resume answers both halves. Nothing is ever uploaded without a label
check first, and an unlabelled upload defaults to the tailored resume.

## LinkedIn outreach (`linkedin_outreach.mjs`)

For each company: searches LinkedIn → opens `/people/` → picks up to 2 members
(recruiters/founders first) → drafts a DM from `config/profile.yml`.

- Dry-run: previews people + drafts, posts nothing, writes `output/linkedin-outreach.json`.
- Live (`--live --headed`): clicks Message, sends the draft, then posts a Discord
  message tagging you (`DISCORD_USER_ID`) with person + draft + sent/skipped status.
- If Message is unavailable (not a connection / InMail only), it reports
  `dm_blocked` with the draft for you to send by hand — never silent.
