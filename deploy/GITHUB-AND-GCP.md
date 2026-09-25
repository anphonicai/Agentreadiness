# Push to GitHub and deploy to GCP

## Current deployment

- Workspace: `/Users/akshita/Downloads/agentnew`
- GCP project: `anphonic-commerce`
- VM: `commerce-app`, zone `asia-south1-a`
- Site: https://commerce.anphonic.ai
- App directory: `/opt/commerce/app`
- Runtime: Node 24, `commerce.service`, Caddy HTTPS proxy
- Production environment: `/etc/commerce.env`
- Persistent databases: `/var/lib/commerce` (paths set in the production environment)

GitHub stores the code. Pushing does **not** deploy automatically. The VM runs an uploaded release, not a Git checkout.

## 1. Push to GitHub

Run from the workspace. Install Git, GitHub CLI and Google Cloud CLI if missing.

```bash
cd /Users/akshita/Downloads/agentnew
gh auth status
# If needed:
gh auth login

git remote -v
# One-time setup: replace OWNER and REPOSITORY with your real destination.
git remote add origin https://github.com/OWNER/REPOSITORY.git
# If origin already exists and needs correcting, use git remote set-url origin URL.

git status --short
git diff --check
npm test
git add leads.js server.js public tests stripe-payment.js deploy
git diff --cached --stat
git commit -m "Save contact enquiries and update premium report flow"
git push -u origin main
```

For subsequent updates, review and stage the specific files you changed, commit, then `git push`. If the remote already contains commits, fetch and reconcile them before pushing; do not force-push over them.

Never commit `.env`, production secrets, SQLite databases, or customer exports. The archive below contains committed files only, so commit changes before deploying.

## 2. Deploy an existing VM

```bash
gcloud auth login
gcloud compute ssh commerce-app --project=anphonic-commerce --zone=asia-south1-a --command='sudo systemctl is-active commerce'

git archive --format=tar.gz --output=/tmp/commerce-release.tar.gz HEAD
gcloud compute scp /tmp/commerce-release.tar.gz deploy/release.sh commerce-app:/tmp/ --project=anphonic-commerce --zone=asia-south1-a
gcloud compute ssh commerce-app --project=anphonic-commerce --zone=asia-south1-a --command='sudo bash /tmp/release.sh /tmp/commerce-release.tar.gz'
```

`release.sh` tests the extracted release, backs up the previous app, stops the service briefly, copies the databases consistently, installs the release, and checks local health. It restores the old code if activation or health checking fails. Backups remain on the VM under `/opt/commerce/backups/TIMESTAMP`; they are not off-VM disaster recovery backups.

The script leaves `/etc/commerce.env` and `/var/lib/commerce` in place. Running scans and pending OTPs reset during the restart. Saved reports, leads and enquiries persist. Keep production mode enabled and Stripe unconfigured until credentials and payment testing are ready.

## 3. Verify the deployment

```bash
curl --fail https://commerce.anphonic.ai/api/version
curl --fail https://commerce.anphonic.ai/contact.html
gcloud compute ssh commerce-app --project=anphonic-commerce --zone=asia-south1-a --command='sudo systemctl is-active commerce'
```

Open the site and check the contact page, scan flow and premium report copy. A contact enquiry should show success only after the database accepts it. Submissions do not send email; the team follows up manually.

For errors:

```bash
gcloud compute ssh commerce-app --project=anphonic-commerce --zone=asia-south1-a
sudo journalctl -u commerce -n 100 --no-pager
```

Do not share logs containing customer details. Do not start another Node process alongside the service.

## 4. View contact enquiries

SSH into the VM. Confirm the `LEADS_DB_PATH` setting privately in `/etc/commerce.env` and use that path below (the normal filename is `leads.sqlite`).

```bash
sudo sqlite3 -header -column /var/lib/commerce/leads.sqlite 'SELECT created_at, company_name, name, email, store_url, message, status FROM contact_enquiries ORDER BY created_at DESC;'
```

These are private customer details. Keep exports outside the repository. Mark a followed-up enquiry using a SQLite client and its `id`; the initial status is `new`.

## 5. Roll back code

Use the exact backup directory printed by the deployment. On the VM:

```bash
sudo systemctl stop commerce
sudo mv /opt/commerce/app /opt/commerce/failed-release-UNIQUE_TIMESTAMP
sudo mv /opt/commerce/backups/DEPLOY_TIMESTAMP/previous-app /opt/commerce/app
sudo systemctl start commerce
curl --fail http://127.0.0.1:3100/api/version
```

This restores code only and preserves enquiries received since deployment. The contact change adds a table and does not require restoring the database. For future incompatible schema changes, plan database rollback separately; restoring an old database loses newer submissions.

`bootstrap.sh`, `commerce.service`, and `Caddyfile` describe initial server provisioning. Do not rerun bootstrap for routine releases.
