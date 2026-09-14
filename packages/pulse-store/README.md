# pulse-store

## Purpose

SQLite schema, audit log, TSV export.

## Public Interface

- See `src/pulseops_store/` modules.

## Config

This package does not parse env vars. Applications inject configuration.

## Dependencies

- Internal: none
- External: see `pyproject.toml`

## Example

```python
import pulseops_store
```

## Future Extraction Guidance

Split into its own repository after reuse in two clients and two stable release cycles.
