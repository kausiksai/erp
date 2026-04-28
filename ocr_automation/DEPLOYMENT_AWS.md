# AWS Deployment — Nightly Pipeline (email + OCR + PO check)

This guide assumes:
- **RDS PostgreSQL** for `billing_system` already exists (the `srimukha…ap-south-1.rds.amazonaws.com` instance).
- **One EC2 instance** in the same VPC / region (so it can reach RDS without going over the public internet).
- The existing **Node backend** is already running somewhere reachable from the EC2 (often the same EC2 instance via `localhost:4000`, or a separate server / ALB).
- You have IAM access to create EC2 + Secrets Manager entries.

The OCR pipeline doesn't need any AWS-specific service — it's plain Python + cron + IAM. RDS, EC2 and Secrets Manager are all you need.

---

## 1. Provision an EC2 host (if not already running)

| Setting | Recommended |
|---------|-------------|
| AMI | Amazon Linux 2023 (ships with Python 3.11) |
| Type | `t3.small` is plenty (this workload is I/O bound, not CPU) |
| EBS | 20 GB gp3 |
| Subnet | Same VPC as RDS — RDS must be reachable from this instance's security group |
| Security group | Egress: 443 (Drive, Landing AI, Anthropic if used), 5432 (RDS) |
| IAM role | Attach a role with: `SecretsManagerReadWrite` (scoped to specific secrets), `CloudWatchAgentServerPolicy` (optional, for log shipping) |

```bash
ssh ec2-user@<host>
sudo dnf -y update
sudo dnf -y install git python3.11 python3.11-pip postgresql15
```

---

## 2. Clone the repo

```bash
cd /opt
sudo mkdir billing && sudo chown ec2-user: billing && cd billing
git clone https://github.com/Sriram-Ananth/erp.git
cd erp
```

---

## 3. Apply database migrations to RDS

```bash
# From any machine that can reach RDS (the EC2 itself, ideally)
psql "host=<RDS_HOST> port=5432 dbname=billing_system user=postgres sslmode=require" \
     -f scripts/migration_email_automation.sql           # already applied — safe re-run
psql "host=<RDS_HOST> port=5432 dbname=billing_system user=postgres sslmode=require" \
     -f scripts/migration_invoice_reconciliation.sql      # already applied — safe re-run
psql "host=<RDS_HOST> port=5432 dbname=billing_system user=postgres sslmode=require" \
     -f scripts/migration_ocr_automation.sql              # NEW
psql "host=<RDS_HOST> port=5432 dbname=billing_system user=postgres sslmode=require" \
     -f scripts/migration_po_check.sql                    # NEW
```

All migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

---

## 4. Set up `email_automation` (already documented elsewhere)

```bash
cd /opt/billing/erp/email_automation
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env — fill in PG creds, IMAP creds (Zoho)
```

Smoke test:
```bash
python -m email_automation.run --source local   # if you have local samples
```

---

## 5. Set up `ocr_automation`

```bash
cd /opt/billing/erp/ocr_automation
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Copy the env template
cp .env.example .env
```

Edit `.env`:
```ini
PGHOST=<RDS_HOST>
PGPORT=5432
PGDATABASE=billing_system
PGUSER=postgres
PGPASSWORD=<from Secrets Manager>
PGSSLMODE=require
PG_MIN_CONN=1
PG_MAX_CONN=12

DRIVE_FOLDER_ID=1296UDEc3BVoTQm_1k6pHlAV63yqam3jD
GOOGLE_SERVICE_ACCOUNT_JSON=/opt/billing/erp/ocr_automation/credentials/service_account.json

BACKEND_BASE_URL=http://localhost:4000/api
BACKEND_AUTH_TOKEN=

OCR_CONCURRENCY=10
OCR_REQUEST_TIMEOUT_SECONDS=180
OCR_MAX_RETRIES=2

# Disable IPv4 forcing on AWS (IPv6 works fine there). Locked off on Mac dev.
OCR_FORCE_IPV4=0

# PO check grace window
PO_CHECK_GRACE_DAYS=7

TIMEZONE=Asia/Kolkata
LOG_LEVEL=INFO
```

### 5a. Place the service-account key

```bash
# Upload the JSON via scp / Secrets Manager / SSM Parameter Store — never commit it.
# Recommended: pull from Secrets Manager at deploy time:
aws secretsmanager get-secret-value \
  --secret-id ocr-automation/google-service-account \
  --query SecretString --output text \
  > /opt/billing/erp/ocr_automation/credentials/service_account.json
chmod 600 /opt/billing/erp/ocr_automation/credentials/service_account.json
```

### 5b. Smoke test (1 file)

```bash
cd /opt/billing/erp
source ocr_automation/venv/bin/activate
python -m ocr_automation.run --limit 1
```

Expected: one row appears in `invoices` with `source='ocr'`. If this fails, fix it before scheduling.

---

## 6. Backend service

The backend must be running at the URL in `BACKEND_BASE_URL` whenever the
nightly pipeline runs. Two options:

### Option A — same EC2 (recommended for small deployments)

```bash
cd /opt/billing/erp/backend
npm ci --production
cp .env.example .env
# Edit .env: same RDS creds + LANDING_AI_API_KEY + JWT_SECRET + RATE_LIMIT_MAX=5000

# Run as a systemd unit so it stays up
sudo tee /etc/systemd/system/billing-backend.service >/dev/null <<'EOF'
[Unit]
Description=Billing System Backend (Express)
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/billing/erp/backend
ExecStart=/usr/bin/node src/index.js
EnvironmentFile=/opt/billing/erp/backend/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now billing-backend
sudo systemctl status billing-backend
curl http://localhost:4000/health
```

### Option B — separate ALB / ECS / Beanstalk
Set `BACKEND_BASE_URL=https://api.billing.internal.yourcompany/api` and ensure the EC2 SG can reach it.

---

## 7. Schedule the nightly pipeline (cron @ 6 AM IST)

### 7a. Make sure timezone is correct

```bash
sudo timedatectl set-timezone Asia/Kolkata
timedatectl   # verify
```

### 7b. Add the cron entry

```bash
crontab -e
```

Paste:
```cron
# Nightly billing pipeline — email → OCR → PO check
0 6 * * *  /opt/billing/erp/scripts/nightly_pipeline.sh >> /var/log/billing/nightly.log 2>&1
```

Create log dir:
```bash
sudo mkdir -p /var/log/billing
sudo chown ec2-user: /var/log/billing
```

Add log rotation:
```bash
sudo tee /etc/logrotate.d/billing-nightly >/dev/null <<'EOF'
/var/log/billing/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
```

### 7c. (Optional but recommended) Use systemd timer instead of cron

systemd is more observable than cron and integrates with `journalctl`.

```bash
sudo tee /etc/systemd/system/billing-nightly.service >/dev/null <<'EOF'
[Unit]
Description=Billing nightly pipeline (email -> OCR -> PO check)
Wants=billing-backend.service
After=billing-backend.service

[Service]
Type=oneshot
User=ec2-user
WorkingDirectory=/opt/billing/erp
ExecStart=/opt/billing/erp/scripts/nightly_pipeline.sh
StandardOutput=append:/var/log/billing/nightly.log
StandardError=append:/var/log/billing/nightly.log
EOF

sudo tee /etc/systemd/system/billing-nightly.timer >/dev/null <<'EOF'
[Unit]
Description=Run billing nightly pipeline at 06:00 IST every day

[Timer]
OnCalendar=*-*-* 06:00:00 Asia/Kolkata
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now billing-nightly.timer
systemctl list-timers | grep billing
```

Pick **either** cron (7b) or systemd (7c) — not both.

---

## 8. Manual trigger (dry run)

You can fire the pipeline by hand any time:

```bash
/opt/billing/erp/scripts/nightly_pipeline.sh
```

Or run a single phase:
```bash
cd /opt/billing/erp
source ocr_automation/venv/bin/activate
python -m ocr_automation.run --limit 5    # 5 files only
python -m ocr_automation.po_check          # PO check only
```

---

## 9. Monitoring & alerts

### Audit tables (the source of truth)
```sql
-- run-level summary
SELECT * FROM ocr_automation_runs ORDER BY started_at DESC LIMIT 10;
SELECT * FROM email_automation_runs ORDER BY started_at DESC LIMIT 10;

-- file-level activity
SELECT status, COUNT(*) FROM ocr_automation_log
  WHERE run_id = (SELECT run_id FROM ocr_automation_runs ORDER BY started_at DESC LIMIT 1)
  GROUP BY 1;

-- pending reconciliation queue (for portal)
SELECT COUNT(*) FROM invoices WHERE reconciliation_status = 'pending_reconciliation';

-- un-invoiced POs
SELECT COUNT(*), SUM(expected_amount) FROM unraised_invoices;
```

### CloudWatch (optional)

Install the agent and ship `/var/log/billing/*.log` plus a metric filter on the
strings `status=failed` / `phase 1/3` / etc.

### Slack/email alert on failure

The wrapper exits non-zero on any phase failure. A simple cron-side alert:

```cron
0 6 * * *  /opt/billing/erp/scripts/nightly_pipeline.sh >> /var/log/billing/nightly.log 2>&1 || \
            curl -X POST -H 'Content-Type: application/json' \
              -d '{"text":"Billing nightly pipeline FAILED"}' \
              "$SLACK_WEBHOOK_URL"
```

---

## 10. Re-running after a Landing AI top-up

When you topped up Landing AI credits (after the credit-quota failures in the
backfill), just re-run:

```bash
python -m ocr_automation.run
```

The 169 already-`processed` rows in `drive_synced_files` are skipped; only the
400 `failed` rows are retried. Failed rows get re-attempted on every run until
they either succeed or you manually mark them `skipped`.

---

## 11. Rollback / disable

```bash
# Disable scheduling
sudo systemctl disable --now billing-nightly.timer       # systemd
crontab -l | grep -v nightly_pipeline | crontab -        # cron

# Stop the backend
sudo systemctl disable --now billing-backend

# The DB stays — safe to re-enable any time
```

---

## 12. Pre-flight checklist (before first scheduled run)

- [ ] EC2 in same VPC as RDS, can `psql` reach
- [ ] Both venvs created (`email_automation/venv`, `ocr_automation/venv`)
- [ ] Both `.env` files filled in, **never** committed
- [ ] Service account JSON in `ocr_automation/credentials/`, `chmod 600`
- [ ] Drive folder shared (Viewer) with the SA email
- [ ] Backend running on `BACKEND_BASE_URL` (curl `/health` returns 200)
- [ ] All 4 SQL migrations applied
- [ ] Single-file smoke test of OCR succeeded (`--limit 1`)
- [ ] PO check produced sane numbers
- [ ] Timezone is `Asia/Kolkata` (or set `OnCalendar` accordingly)
- [ ] `/var/log/billing` exists and writable, log rotation in place
- [ ] Cron / systemd timer enabled and visible in `crontab -l` / `systemctl list-timers`
