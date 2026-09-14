# pulse-core

## Purpose

CV parsing, profile building, sourcing, resume building.

## Public Interface

- See `src/pulseops_core/` modules.

## Config

This package does not parse env vars. Applications inject configuration.

## Dependencies

- Internal: none
- External: see `pyproject.toml`

## Example

```python
import pulseops_core
```

## Future Extraction Guidance

Split into its own repository after reuse in two clients and two stable release cycles.
