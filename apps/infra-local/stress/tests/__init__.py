"""Correctness suite for the harness itself.

Not an integration test: nothing here touches a stack. These assert the rules the
verdict rests on — what gets recorded, what gets compared, and whether a real
divergence actually surfaces — against this package's own code, with the box,
the truth store and the fleet replaced by fakes.

    python -m unittest discover -s stress/tests -t .
"""
