"""Email automation pipeline for the billing system.

Fetches reference and invoice data from the Zoho mailbox, loads it into
Postgres directly (no dependency on the Node backend), and runs the full
validation engine on newly arrived invoices.

Package layout:
    config.py        typed env loader
    db.py            psycopg2 pool + context managers
    logger.py        rotating file + console logging
    audit.py         email_automation_log / _runs helpers
    parsers/         Excel -> dicts  (phase 2)
    loaders/         dicts -> Postgres  (phase 2)
    validation/      validation engine + gap-list fixes  (phase 3)
    mailbox/         IMAP client + classifier  (phase 4)
    run.py           entry point  (phase 4)
"""

__version__ = "0.1.0"
