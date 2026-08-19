"""Orchestration: what runs when, what the verdict is, and how it is torn down.

Layer 4 — depends on `ops`, `domain` and `store`; the CLI and the report sit
above it.

Deliberately empty of re-exports. `report` needs the sweep's verdict types and
`session` needs the report, so a package `__init__` that eagerly imported
`session` would make importing *either* module import both — a cycle that only
shows up at run time. Import the modules directly: `from .run.session import …`.
"""
