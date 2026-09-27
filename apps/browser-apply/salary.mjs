// Salary floor for applications, and a dependency-free basic-HTML reader for
// employer careers sites that render poorly in a full browser.
//
// Only acts on postings that *state* a salary. A role with no disclosed pay is
// never skipped, because inventing a threshold would drop good applications.

const MIN_MONTHLY_INR = 10000; // 10k INR/month == 1.2 LPA per annum

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const CR = String.raw`(?:₹|rs\.?|inr)`;
const MONTHLY_RE = new RegExp(
  String.raw`${CR}?\s*${NUM}\s*(?:k\s*)?(?:per\s*month|\/\s*month|\/\s*mo\b|p\.?m\.?\b|monthly|pm\b|a\s*month)`,
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
  String.raw`${CR}?\s*${NUM}\s*(?:per\s*annum|annually|pa|p\.?a\.?\b|a\s*year)`,
  "i",
);

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

/** Best-effort INR-per-month figure from free text, or null. */
function monthlyInrFromText(text) {
  if (!text) return null;
  const blob = String(text);

  let m = MONTHLY_RE.exec(blob);
  if (m) {
    // No \b before k: in "40k" the digit and k are both word characters.
    const hasK = /\d\s*k\s*(?:per\s*month|\/\s*month|p\.?m\.?\b|monthly|pm\b)/i.test(m[0]);
    const n = toNumber(m[1]);
    if (n !== null) return hasK ? n * 1000 : n;
  }

  m = HOURLY_RE.exec(blob);
  if (m) {
    const hasK = /\d\s*k\s*(?:per\s*hour|\/\s*hour|\/\s*hr\b|hourly)/i.test(m[0]);
    const n = toNumber(m[1]);
    if (n !== null) return (hasK ? n * 1000 : n) * 22 * 12;
  }

  m = LPA_RE.exec(blob);
  if (m) {
    const n = toNumber(m[1]);
    if (n !== null) return (n * 100000) / 12;
  }

  m = PLAIN_ANNUAL_RE.exec(blob);
  if (m) {
    const digits = m[0].replace(/₹/g, " ").match(/[\d,]+/g);
    if (digits && digits.length) {
      const n = toNumber(digits[0]);
      if (n !== null) return n / 12;
    }
  }
  return null;
}

/**
 * Should this posting be skipped for stating a salary below the floor?
 * Returns { skip, monthly }. `skip` is true only when a figure was found AND
 * it is under the threshold.
 */
function statedSalaryTooLow(text, minimumMonthlyInr = MIN_MONTHLY_INR) {
  const monthly = monthlyInrFromText(text);
  if (monthly === null) return { skip: false, monthly: null };
  return { skip: monthly < minimumMonthlyInr, monthly };
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
};
