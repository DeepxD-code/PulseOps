"""
exceptions.py — All typed exceptions for PulseOps
No logic. No imports. Just class definitions.
Every module raises from this file — never raises raw Exception.
"""


class PulseOpsError(Exception):
    """Base exception for all PulseOps errors."""
    pass


# ── Sourcing ──────────────────────────────────────────────────────────────

class SourceError(PulseOpsError):
    """A job source failed to return results."""
    pass

class LinkedInBridgeError(SourceError):
    """LinkedIn Node.js bridge failed."""
    pass

class GoogleJobsError(SourceError):
    """Google Jobs / SearchApi.io request failed."""
    pass

class TheirStackError(SourceError):
    """TheirStack API request failed."""
    pass

class HimalayasError(SourceError):
    """Himalayas public API request failed."""
    pass

class PlaywrightScanError(SourceError):
    """Playwright portal scan failed."""
    pass


# ── Evaluation ────────────────────────────────────────────────────────────

class EvaluationError(PulseOpsError):
    """LLM evaluation failed."""
    pass

class AllEnginesFailedError(EvaluationError):
    """All LLM engines in the cascade failed."""
    pass

class SchemaValidationError(EvaluationError):
    """LLM output failed Pydantic schema validation after all retries."""
    pass

class PreFilterRejectedError(EvaluationError):
    """Job rejected at domain filter stage before LLM evaluation."""
    pass


# ── Send Guardrails ───────────────────────────────────────────────────────

class SendGuardrailError(PulseOpsError):
    """A send guardrail blocked the outreach."""
    pass

class ScoreBelowThresholdError(SendGuardrailError):
    """G1: Score did not meet SEND_THRESHOLD."""
    pass

class SemanticDuplicateError(SendGuardrailError):
    """G2: This role was already applied to (semantic dedup)."""
    pass

class BlacklistMatchError(SendGuardrailError):
    """G3: Company or domain matched blacklist entry."""
    pass

class ReferralContactExistsError(SendGuardrailError):
    """G4: A contact exists at this company — cold email blocked."""
    pass

class CooldownActiveError(SendGuardrailError):
    """G5: Company is within the 30-day cooldown window."""
    pass

class DomainDailyLimitError(SendGuardrailError):
    """G6: Domain has already received max emails today."""
    pass

class DailyCapReachedError(SendGuardrailError):
    """G7: Daily send cap reached — job queued for next run."""
    pass

class OutsideSendWindowError(SendGuardrailError):
    """G8: Current time is outside the configured send window — job queued."""
    pass

class BounceThresholdReachedError(SendGuardrailError):
    """G9: Domain is bounce-paused after repeated bounces."""
    pass

class NoContactEmailError(SendGuardrailError):
    """G10: No contact email found and no domain could be inferred."""
    pass


# ── CV / Profile / Resume ─────────────────────────────────────────────────

class CVParseError(PulseOpsError):
    """cv.md could not be parsed (missing required section, malformed, etc)."""
    pass

class ProfileBuildError(PulseOpsError):
    """profile.yml could not be generated from CVData."""
    pass

class ResumeBuildError(PulseOpsError):
    """Company-specific resume could not be built or PDF was empty."""
    pass


# ── Memory ────────────────────────────────────────────────────────────────

class MemoryParseError(PulseOpsError):
    """LLM could not structure the raw memory input into a typed ParsedMemory."""
    pass

class MemoryStorageError(PulseOpsError):
    """Memory could not be written to the database."""
    pass


# ── Infrastructure ────────────────────────────────────────────────────────

class DatabaseError(PulseOpsError):
    """SQLite operation failed."""
    pass

class ConfigError(PulseOpsError):
    """Configuration file missing, malformed, or has invalid values."""
    pass

class AuditLogError(PulseOpsError):
    """Audit log write failed (non-fatal — pipeline continues)."""
    pass

class TelegramError(PulseOpsError):
    """Telegram Bot API request failed (non-fatal — pipeline continues)."""
    pass

class IMAPError(PulseOpsError):
    """IMAP Gmail connection or search failed (non-fatal)."""
    pass
