"""Excel parsers for the six document types processed by the email automation.

Every parser module exposes a single public function `parse(path_or_bytes)`
that returns a list of dictionaries. Each dict is a normalised row ready to
be handed to the matching loader.

Parsers never touch the database — they only transform Excel into Python.
"""
