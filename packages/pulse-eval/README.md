# pulse-eval

## Purpose

Domain filters, dedup, LLM evaluation cascade.

## Public Interface

- See `src/pulseops_eval/` modules.

## Config

This package does not parse env vars. Applications inject configuration.

## Dependencies

- Internal: none
- External: see `pyproject.toml`

## Example

```python
import pulseops_eval
```

## Future Extraction Guidance

Split into its own repository after reuse in two clients and two stable release cycles.
