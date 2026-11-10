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
from the board's own option list:- **Years of experience as a band.** Greenhouse offers
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
- **Availability bands.** "Available to start (a notice period)" offers
  `Available immediately`, `Available within 2-4 weeks`, `Available within
  1-2 months`. The stated notice period is read in days and the narrowest band
  containing it is chosen (`noticeBandFor`).
- **Place-of-residence options.** "What is your current place of residence?
  (choose one of the options)" lists cities. The option naming
  `candidate.current_location` is selected — an exact match before a prefix one,
  so "Delhi" is not answered with "New Delhi" when both are offered — and a list
  without his city is left blank rather than approximated.

A job details page whose only control is "Apply for this job" is *not* a
rendered form: the run waits for real fields before filling, then clicks the
opener (Keka did this in reverse and recorded a click on the opener as the
submission). The same rule keeps a hop that already landed on an `/apply` route
from re-clicking that form's own submit.

### Keka's two gates

Keka (`*.keka.com`) puts the form one click behind "Apply for this job" and then
asks for things no profile can answer by itself:

- **An image captcha** (`#captcha` plus a 120×40 picture). It cannot be read
  honestly by a program, and it never disappears while the page stays on the
  form, so the vendor-widget wait would expire. With `--headed --otp-pause` the
  run fills everything, prints `[handoff] type the captcha…`, and submits as soon
  as the box holds a value. Without those flags the row is recorded for a human.
- **A candidate-consent checkbox that is not marked `required`** but is the
  switch that enables "Apply Now". Under `--accept-terms` the run ticks a consent
  it recognises (terms/privacy/consent, never marketing) once the button is
  actually disabled, then re-reads the button.

`firstAmount()` supplies the bare number for a `*.amount` control, whose currency
and "Monthly" period are separate controls on the same row.

### Questions only the candidate can answer

Three of the questions Indian boards ask most often are judgements or
representations, never derivable facts, so they live in
`application_answers` and are used only where the profile states them:

- **A per-skill years figure** (`skill_years`) answers "How many years of
  hands-on experience do you have with Java in a professional environment?". It
  is never the total: `skillScopedQuestion()` makes the general
  `years of experience` fact stand down on any question naming a technology, so
  a language the CV does not claim stays blank instead of inheriting 0.2 years
  (#1320 Zema, 2026-11-10).
- **A 1–10 self-rating** (`skill_ratings`) answers "Rate your proficiency in
  Java (1 = beginner, 10 = expert)". Skills are matched however the board spells
  them — "Spring Boot" and "SpringBoot" are one skill — and `MySQL` is not `SQL`.
- **The current package** (`current_compensation`) wins over the figure derived
  from `current_company`, because "Internship stipend only" says more than `0`.

The Zema wording *"How far do you live from &lt;office&gt;? … are you willing to
relocate at your own expense?"* is answered by `location_distance` with the
stated sentence: where he actually lives, and what he has agreed to do. No
distance in kilometres is claimed, because none was measured.

### What counts as a confirmation

A click is never a submission on its own. The row is only recorded `Verified`
when the board itself says so, in either of two shapes:

- the page it already has prints it ("application submitted", "thanks for
  applying", a visible "Applied" badge), or
- it **navigates to its own confirmation route** — `/careers/success/<id>`,
  `/thank-you`, `/confirmation`, `/applied`. Keka does this: on 2026-11-09 (#1319)
  the submit answered `200` and the page fetched `/careers/success/94986`, and the
  run still filed the row as an error because it only looked for words.

Only an address reached *after* the press counts, and it is read from the
page's navigation log rather than from `page.url()`, because the board may close
the window straight afterwards. A closed page is therefore no longer an error:
questions to it are skipped, and the landing route decides the row.

## LinkedIn outreach (`linkedin_outreach.mjs`)

For each company: searches LinkedIn → opens `/people/` → picks up to 2 members
(recruiters/founders first) → drafts a DM from `config/profile.yml`.

- Dry-run: previews people + drafts, posts nothing, writes `output/linkedin-outreach.json`.
- Live (`--live --headed`): clicks Message, sends the draft, then posts a Discord
  message tagging you (`DISCORD_USER_ID`) with person + draft + sent/skipped status.
- If Message is unavailable (not a connection / InMail only), it reports
  `dm_blocked` with the draft for you to send by hand — never silent.
