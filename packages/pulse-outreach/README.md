# pulse-outreach

## Purpose

10-guardrail send engine, SMTP, followups.

## Public Interface

- See `src/pulseops_outreach/` modules.

## Config

This package does not parse env vars. Applications inject configuration.

## Dependencies

- Internal: none
- External: see `pyproject.toml`

## Example

```python
import pulseops_outreach
```

## Future Extraction Guidance

Split into its own repository after reuse in two clients and two stable release cycles.
