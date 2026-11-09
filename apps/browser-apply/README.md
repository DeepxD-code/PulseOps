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

## Screening questions

Facts come from `config/profile.yml`. A question is answered only when the
profile actually holds the answer; anything else is left blank and named in the
log as `[answer-missing]`, then collected in `output/pending-questions.json`.

Two shapes cannot be answered with a string at all, because the answer is chosen
from the board's own option list:

- **Years of experience as a band.** Greenhouse offers
  `Intern / Fresher`, `Less than 5 Years`, `5-8 Years`, `Above 8+ Years` rather
  than a number. The band is picked so that it contains
  `candidate.experience_years` (`experienceBandFor`). A question scoped to a
  technology ("…writing Go (Golang) or Ruby?") is answered differently
  (`skillYearsOption`): the band when `config/profile.yml` lists that technology,
  `None` when it lists none of them and the board offers it, and nothing at all
  when it cannot tell — so it never claims a language the CV does not have.
- **Presence questions.** "This role requires candidate to be present in
  Bengaluru, what best describe your situation?" offers a "can relocate to
  Bangalore" option. That option is only selected for a city listed in
  `application_answers.relocation_cities`, and never for the city he already
  lives in (`relocationOption`).

## LinkedIn outreach (`linkedin_outreach.mjs`)

For each company: searches LinkedIn → opens `/people/` → picks up to 2 members
(recruiters/founders first) → drafts a DM from `config/profile.yml`.

- Dry-run: previews people + drafts, posts nothing, writes `output/linkedin-outreach.json`.
- Live (`--live --headed`): clicks Message, sends the draft, then posts a Discord
  message tagging you (`DISCORD_USER_ID`) with person + draft + sent/skipped status.
- If Message is unavailable (not a connection / InMail only), it reports
  `dm_blocked` with the draft for you to send by hand — never silent.
