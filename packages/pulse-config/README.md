# pulse-config

## Purpose

Shared prompts, templates, example configs.

## Public Interface

- See `src/pulseops_config/` modules.

## Config

This package does not parse env vars. Applications inject configuration.

## Dependencies

- Internal: none
- External: see `pyproject.toml`

## Example

```python
import pulseops_config
```

## Future Extraction Guidance

Split into its own repository after reuse in two clients and two stable release cycles.
