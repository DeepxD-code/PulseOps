# browser-apply

Playwright auto-apply + LinkedIn outreach. Needs `portal/storageState.json`
(run `node save_sessions.mjs`, log in with email, press Enter).

## Scripts

- `npm run apply` — dry-run previews, no submits.
- `npm run apply:live` — fill + submit with saved session (`--live --headed --auto`).
- `npm run find -- --company "Acme"` — dry-run LinkedIn people finder for one company.
- `npm run find:live -- --all` — find people for queued jobs + send DMs + Discord @-tag.

## LinkedIn outreach (`linkedin_outreach.mjs`)

For each company: searches LinkedIn → opens `/people/` → picks up to 2 members
(recruiters/founders first) → drafts a DM from `config/profile.yml`.

- Dry-run: previews people + drafts, posts nothing, writes `output/linkedin-outreach.json`.
- Live (`--live --headed`): clicks Message, sends the draft, then posts a Discord
  message tagging you (`DISCORD_USER_ID`) with person + draft + sent/skipped status.
- If Message is unavailable (not a connection / InMail only), it reports
  `dm_blocked` with the draft for you to send by hand — never silent.
