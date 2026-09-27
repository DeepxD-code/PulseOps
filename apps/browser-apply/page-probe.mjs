// Cheap, dependency-free classification of a job page before any browser is
// launched. Many employer career sites are plain server-rendered HTML; those
// can be read (and often submitted) without a full browser, which is far faster
// and far less fragile than driving a script bundle we do not control.

const BASIC_HTML = "basic-html";
const STYLED_PAGE = "styled-page";

/**
 * Decide whether a document is essentially unstyled, server-rendered HTML.
 *
 * Signals used, in order of confidence:
 *  - a real stylesheet or <style> block means the page is styled by definition
 *  - a client framework root (id/class markers) means the body is a shell
 *  - a large inline script share means the text is not the primary content
 *  - server-rendered text length in the body is the positive signal
 */
function detectBasicHtml(html) {
  const doc = String(html || "");
  if (!doc.trim()) {
    return { mode: STYLED_PAGE, reason: "empty document", basic: false, signals: {}, text: "" };
  }

  const lower = doc.toLowerCase();
  const hasStyleBlock = /<style[\s>]/i.test(doc);
  const hasStylesheetLink = /<link[^>]+rel=["']?stylesheet/i.test(doc);
  const hasFrameworkRoot =
    /id=["'](?:root|app|__next|__nuxt)["']/i.test(doc) ||
    /data-reactroot|data-react-helmet|data-v-app/i.test(doc);
  const scriptBytes = (doc.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [])
    .join("")
    .replace(/<script\b[^>]*>|<\/script>/gi, "").length;
  const docBytes = doc.length || 1;
  const scriptShare = scriptBytes / docBytes;

  // Text that is server-rendered into the body, ignoring script/style content.
  const bodyMatch = doc.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : doc;
  const text = basicHtmlTextFromHtml(bodyHtml);
  const textLength = text.trim().length;
  const hasVisibleForm = /<input\b|<textarea\b|<select\b/i.test(bodyHtml);

  const signals = {
    hasStyleBlock,
    hasStylesheetLink,
    hasFrameworkRoot,
    scriptShare: Number(scriptShare.toFixed(3)),
    textLength,
    hasVisibleForm,
  };

  if (hasStyleBlock || hasStylesheetLink) {
    return { mode: STYLED_PAGE, reason: "page carries CSS", basic: false, signals, text };
  }
  if (hasFrameworkRoot) {
    return { mode: STYLED_PAGE, reason: "client framework root", basic: false, signals, text };
  }
  if (scriptShare > 0.5) {
    return { mode: STYLED_PAGE, reason: "mostly script payload", basic: false, signals, text };
  }
  // A genuine server-rendered job page can be short; the framework-root check
  // above already catches SPA shells, so this is only a backstop against a
  // document that is essentially empty.
  if (textLength < 120) {
    return {
      mode: STYLED_PAGE,
      reason: "too little server-rendered text to trust",
      basic: false,
      signals,
      text,
    };
  }
  return { mode: BASIC_HTML, reason: "unstyled server-rendered HTML", basic: true, signals, text };
}

/**
 * Read a page as plain text with no stylesheet, script or layout dependency.
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
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export { BASIC_HTML, STYLED_PAGE, basicHtmlTextFromHtml, detectBasicHtml };
