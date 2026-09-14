# pulse-github

## Purpose

GitHub resume sync.

## Public Interface

- See `src/pulseops_github/` modules.

## Config

This package does not parse env vars. Applications inject configuration.

## Dependencies

- Internal: none
- External: see `pyproject.toml`

## Example

```python
import pulseops_github
```

## Future Extraction Guidance

Split into its own repository after reuse in two clients and two stable release cycles.
