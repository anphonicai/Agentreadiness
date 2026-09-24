# Current GCP deployment

- Project: anphonic-commerce (493330381075)
- VM: commerce-app, asia-south1-a, e2-medium
- Static IP: 34.93.240.194 (commerce-ip)
- URL: https://commerce.anphonic.ai
- Runtime: Node 24, systemd commerce.service, Caddy HTTPS proxy
- Code: /opt/commerce/app (uploaded from this workspace, not a Git checkout)
- Secrets: /etc/commerce.env, root-only
- Databases: /var/lib/commerce, private persistent boot-disk storage
- Production mode, local proxy trust enabled, Stripe disabled

GoDaddy A record: commerce -> 34.93.240.194. Preserve Resend DNS records.

Use `gcloud compute ssh commerce-app --project=anphonic-commerce --zone=asia-south1-a`
then `sudo systemctl restart commerce` to restart; `sudo journalctl -u commerce -n 100`
for app logs. Do not start a second Node process.

Deployment is single-process. Pending OTPs and running scans reset on restart;
completed reports and leads persist. Disk retention is enabled on VM deletion.
Scheduled backups and billing alerts still need configuring. Use SQLite's online
backup API or stop the service for consistent database copies before off-VM backup.
Do not upload local databases, .env files in code archives, or secrets to GitHub.

The server enforces public-only DNS/IP resolution per scanner request and redirect,
bounds response sizes, and trusts X-Real-IP only from the explicitly enabled local
proxy. Caddy overwrites that header. Port 3100 binds to loopback.

Paid reports show coming soon until Stripe is configured and tested. Keep
NODE_ENV=production and REPORT_EMAIL_PREVIEW=0. OTP inbox delivery and complete
real-user scans should be validated from the deployed site before announcing launch.
