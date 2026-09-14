PYTHON ?= python

.PHONY: setup test lint

setup:
	bash scripts/bootstrap.sh

test:
	bash scripts/test.sh

lint:
	bash scripts/lint.sh
