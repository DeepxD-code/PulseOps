# pulse-memory

## Purpose

3-layer memory, outcomes, context loader.

## Public Interface

- See `src/pulseops_memory/` modules.

## Config

This package does not parse env vars. Applications inject configuration.

## Dependencies

- Internal: none
- External: see `pyproject.toml`

## Example

```python
import pulseops_memory
```

## Future Extraction Guidance

Split into its own repository after reuse in two clients and two stable release cycles.
