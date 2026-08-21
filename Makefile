# Makefile for the api-gateway project.
# The Node/TypeScript build still uses the root package.json; this Makefile
# only wraps the new native PyQt6 desktop app.

PYTHON ?= python3
VENV   := .venv
PIP    := $(VENV)/bin/pip
PYEXE  := $(VENV)/bin/python

.PHONY: setup run install-app uninstall-app clean test test-python

setup:
	$(PYTHON) -m venv $(VENV)
	$(PIP) install -U pip setuptools wheel
	$(PIP) install -e .[dev]

run:
	$(PYEXE) -m api_gateway_app

install-app:
	bash scripts/install.sh

uninstall-app:
	bash scripts/uninstall.sh

test-python:
	$(PYEXE) -m unittest discover -s tests -p 'test_*.py'

test:
	npm test
	$(MAKE) test-python

clean:
	rm -rf build dist *.egg-info $(VENV) \
	       src/*.egg-info .pytest_cache \
	       $$(find src tests -name '__pycache__' -type d 2>/dev/null)
