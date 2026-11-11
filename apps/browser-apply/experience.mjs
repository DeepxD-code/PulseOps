/**
 * Work-history dates for the forms that ask for them.
 *
 * LinkedIn's Easy Apply inserts a "Work experience" step that renders an
 * "Edit experience" form inside the wizard and refuses to advance until the
 * required "Dates of employment" selects are filled (#1033 Heads Up For Tails,
 * 2026-11-10). The dates live in the CV, so they are transcribed by the
 * operator into `application_answers.experience_history` and read from there -
 * never inferred from the posting.
 *
 * Matching is deliberately conservative: the form names a title and a company,
 * this returns the entry that states both, and returns null when nothing matches
 * cleanly or two entries tie. An unanswered date is recoverable; a wrong date
 * written into the candidate's real profile is not.
 */

const LEGAL_SUFFIX = /\b(?:llp|pvt|private|ltd|limited|inc|incorporated|corp|corporation|llc|co)\b/g;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return new Set(normalize(value).split(" ").filter((word) => word.length > 2));
}

function overlap(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * The month label LinkedIn's date selects use. Accepts a month number, a full
 * or abbreviated name, and returns null for anything else so the caller leaves
 * the select alone.
 */
export function monthLabel(value) {
  if (typeof value === "number" && value >= 1 && value <= 12) return MONTHS[value - 1];
  const text = String(value || "").trim();
  if (!text) return null;
  const digits = Number(text);
  if (Number.isInteger(digits) && digits >= 1 && digits <= 12) return MONTHS[digits - 1];
  const lower = text.toLowerCase();
  const full = MONTHS.find((name) => name.toLowerCase() === lower);
  if (full) return full;
  const short = MONTHS.find((name) => name.toLowerCase().slice(0, 3) === lower.slice(0, 3));
  return short || null;
}

/** A four-digit year as the select's option label, or null. */
export function yearLabel(value) {
  const text = String(value || "").trim();
  if (!/^(?:19|20)\d{2}$/.test(text)) return null;
  return text;
}

/**
 * The dates a form should be filled with, taken from one history entry.
 * `end` is null when the entry is the current role.
 */
export function experienceDates(entry) {
  if (!entry || typeof entry !== "object") return null;
  const startMonth = monthLabel(entry.start_month);
  const startYear = yearLabel(entry.start_year);
  if (!startMonth || !startYear) return null;
  const current = entry.current === true;
  if (current) return { startMonth, startYear, endMonth: null, endYear: null, current: true };
  const endMonth = monthLabel(entry.end_month);
  const endYear = yearLabel(entry.end_year);
  if (!endMonth || !endYear) return null;
  return { startMonth, startYear, endMonth, endYear, current: false };
}

/**
 * Pick the history entry a form's own (title, company) pair refers to.
 * Returns { entry, dates, score } or null.
 */
export function matchExperienceEntry(history, { title, company } = {}) {
  if (!Array.isArray(history) || !history.length) return null;
  const wantedCompany = normalize(company);
  const wantedTitle = normalize(title);
  if (!wantedCompany && !wantedTitle) return null;

  const scored = [];
  for (const entry of history) {
    const dates = experienceDates(entry);
    if (!dates) continue;
    const entryCompany = normalize(entry.company);
    const entryTitle = normalize(entry.title);
    let companyScore = 0;
    if (wantedCompany && entryCompany) {
      if (wantedCompany === entryCompany) companyScore = 1;
      else if (wantedCompany.includes(entryCompany) || entryCompany.includes(wantedCompany)) companyScore = 0.8;
    }
    const titleScore = overlap(wantedTitle, entryTitle);
    // A form whose company matches nothing this profile states is not answered
    // from a lookalike: the dates would be attached to the wrong employer.
    if (!companyScore) continue;
    if (titleScore < 0.5 && history.filter((other) => normalize(other.company) === entryCompany).length > 1) {
      // Two roles at the same employer: the title has to tell them apart.
      continue;
    }
    scored.push({ entry, dates, score: companyScore * 2 + titleScore });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) < 0.001) return null;
  return scored[0];
}

/** True when a wizard step is the work-experience form that wants dates. */
export function isExperienceStepText(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return false;
  if (!/\bdates? of employment\b/i.test(flat)) return false;
  return /\b(?:edit|add)\s+(?:work\s+)?experience\b/i.test(flat);
}
