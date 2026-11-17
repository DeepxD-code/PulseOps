// Salary floor for applications, and a dependency-free basic-HTML reader for
// employer careers sites that render poorly in a full browser.
//
// Only acts on postings that *state* a salary. A role with no disclosed pay is
// never skipped, because inventing a threshold would drop good applications.

const MIN_MONTHLY_INR = 10000; // 10k INR/month == 1.2 LPA per annum

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const CR = String.raw`(?:₹|rs\.?|inr)`;
const MONTH_PERIOD = String.raw`(?:per\s*month|\/\s*month|\/\s*mo\b|p\.?m\.?\b|monthly|pm\b|a\s*month)`;
// "pm" is ambiguous. It is the ordinary Indian shorthand for "per month" in
// "40k pm", and it is also how a clock time is written. Matching "1 PM" as one
// rupee a month skipped #1202 gitlab on 2026-11-10 - a People Systems Engineer
// posting whose only "PM" was a time. So a bare "pm" is only read as pay when
// the same fragment names money (₹/Rs/INR) or thousands ("40k"), and words that
// can only mean a period stand on their own.
const MONTHLY_RE = new RegExp(String.raw`${CR}\s*${NUM}\s*k?\s*${MONTH_PERIOD}`, "i");
const MONTHLY_K_RE = new RegExp(String.raw`${NUM}\s*k\s*${MONTH_PERIOD}`, "i");
const MONTHLY_WORDED_RE = new RegExp(
  String.raw`${NUM}\s*(?:per\s*month|monthly|a\s*month)`,
  "i",
);
const HOURLY_RE = new RegExp(
  String.raw`${CR}?\s*${NUM}\s*(?:k\s*)?(?:per\s*hour|\/\s*hour|\/\s*hr\b|hourly)`,
  "i",
);
const LPA_RE = new RegExp(
  String.raw`${CR}?\s*${NUM}\s*(?:-\s*${NUM}\s*)?(?:lpa|lakhs?(?:\s*(?:per\s*annum|pa|p\.?a\.?))?)`,
  "i",
);
const PLAIN_ANNUAL_RE = new RegExp(
  String.raw`${CR}?\s*${NUM}\s*(?:per\s*annum|annually|pa\b|p\.?a\.?\b|a\s*year)`,
  "i",
);

/**
 * A four-digit number in the calendar range is a year, not a salary.
 *
 * "2026 pa" (an eligibility line — "2026 pass outs") was read as ₹2026 per annum
 * and skipped #1278 Meril for ₹169/month on 2026-11-10. A real figure names its
 * currency, so the year is only forgiven when the fragment does not.
 */
function isYearNotSalary(fragment, value) {
  if (/(?:₹|rs\.?|inr)/i.test(String(fragment))) return false;
  return Number.isInteger(value) && value >= 1900 && value <= 2100;
}
function toNumber(value) {
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Best-effort INR-per-month figure from free text.
 *
 * Returns `{ monthly, matched }` rather than a bare number: a skip is a
 * decision not to apply, and when the figure is wrong there was no way to tell
 * what the page had actually said. `matched` is the exact fragment the rule
 * fired on, so a mis-read is visible in the log instead of silently discarding
 * a posting (#1202 gitlab, 2026-11-10: "stated Rs 1/month" on a page whose
 * salary line was never printed).
 */
function salaryFigureFromText(text) {
  if (!text) return { monthly: null, matched: "" };
  const blob = String(text);

  let m = MONTHLY_RE.exec(blob);
  if (m) {
    // No \b before k: in "40k" the digit and k are both word characters.
    const hasK = /\d\s*k\s*(?:per\s*month|\/\s*month|p\.?m\.?\b|monthly|pm\b)/i.test(m[0]);
    const n = toNumber(m[1]);
    if (n !== null) return { monthly: hasK ? n * 1000 : n, matched: m[0] };
  }

  m = MONTHLY_K_RE.exec(blob);
  if (m) {
    const n = toNumber(m[1]);
    if (n !== null) return { monthly: n * 1000, matched: m[0] };
  }

  m = MONTHLY_WORDED_RE.exec(blob);
  if (m) {
    const n = toNumber(m[1]);
    if (n !== null) return { monthly: n, matched: m[0] };
  }

  m = HOURLY_RE.exec(blob);
  if (m) {
    const hasK = /\d\s*k\s*(?:per\s*hour|\/\s*hour|\/\s*hr\b|hourly)/i.test(m[0]);
    const n = toNumber(m[1]);
    if (n !== null) return { monthly: (hasK ? n * 1000 : n) * 22 * 12, matched: m[0] };
  }

  m = LPA_RE.exec(blob);
  if (m) {
    const n = toNumber(m[1]);
    if (n !== null && !isYearNotSalary(m[0], n)) return { monthly: (n * 100000) / 12, matched: m[0] };
  }

  m = PLAIN_ANNUAL_RE.exec(blob);
  if (m) {
    const digits = m[0].replace(/₹/g, " ").match(/[\d,]+/g);
    if (digits && digits.length) {
      const n = toNumber(digits[0]);
      if (n !== null && !isYearNotSalary(m[0], n)) return { monthly: n / 12, matched: m[0] };
    }
  }
  return { monthly: null, matched: "" };
}

/** Best-effort INR-per-month figure from free text, or null. */
function monthlyInrFromText(text) {
  return salaryFigureFromText(text).monthly;
}

/**
 * Should this posting be skipped for stating a salary below the floor?
 * Returns { skip, monthly, matched }. `skip` is true only when a figure was
 * found AND it is under the threshold.
 *
 * Zero is not a low salary, it is the absence of one: boards that have not
 * filled in a pay field render "₹0 per month" (or a range starting at 0), and
 * reading that as "pays nothing" skipped #1319 Nudge on 2026-11-09 - a
 * Bengaluru backend internship whose LinkedIn page carries no pay statement at
 * all. Treat a zero as undisclosed, which the filter already never skips.
 */
function statedSalaryTooLow(text, minimumMonthlyInr = MIN_MONTHLY_INR) {
  const { monthly, matched } = salaryFigureFromText(text);
  if (monthly === null) return { skip: false, monthly: null, matched: "" };
  if (monthly <= 0) return { skip: false, monthly, matched };
  return { skip: monthly < minimumMonthlyInr, monthly, matched };
}

/**
 * Should this posting be skipped because the internship is unpaid?
 *
 * The floor above only fires on a figure, and "unpaid" is not a figure: a
 * posting that says it pays nothing states no salary at all, so it read as
 * "undisclosed" and was applied to. The operator's rule is one line - unpaid
 * means no (2026-11-17) - and it is about internships specifically, because
 * "unpaid" in a full-time description is almost always "unpaid leave",
 * "unpaid overtime" or "unpaid day off" in the perks list.
 *
 * So the word only counts when the posting is an internship (title or text)
 * and the word is not followed by one of those nouns. "No stipend", "without
 * stipend", "stipend: none", "uncompensated" and "equity only" say the same
 * thing without the word.
 */
const UNPAID_MARKER =
  /(?:\bunpaid\b|\bnot\s+(?:a\s+)?paid\b|\bwithout\s+(?:a\s+)?(?:stipend|pay|compensation)\b|\bno\s+(?:stipend|pay|compensation)\b|\bstipend\s*[:\-]?\s*(?:none|nil|unpaid)\b|\buncompensated\b|\bequity[\s-]+only\b)/i;
// "unpaid leave", "unpaid overtime" and friends are a benefit, not the wage.
const UNPAID_AS_A_BENEFIT =
  /\bunpaid\s+(?:leave|holiday|holidays|day|days|time\s*off|overtime|absence|sick|internship\s+(?:leave|policy))\b/i;
const INTERNSHIP_CONTEXT = /\b(?:intern|internship|interns|trainee|traineeship)\b/i;

function unpaidInternship(text) {
  const blob = String(text || "");
  if (!INTERNSHIP_CONTEXT.test(blob)) return { skip: false, matched: "" };
  const m = UNPAID_MARKER.exec(blob);
  if (!m) return { skip: false, matched: "" };
  const around = blob.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
  if (UNPAID_AS_A_BENEFIT.test(around)) return { skip: false, matched: "" };
  return { skip: true, matched: m[0] };
}

/**
 * Read a page as plain text with no stylesheet, script or layout dependency.
 * Used when a full browser render fails on an employer careers site: the
 * submission-relevant content is almost always in the static markup.
 */
function basicHtmlTextFromHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Numeric entities, e.g. the rupee sign arrives as &#8377; on many portals.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export {
  MIN_MONTHLY_INR,
  basicHtmlTextFromHtml,
  monthlyInrFromText,
  statedSalaryTooLow,
  unpaidInternship,
};
