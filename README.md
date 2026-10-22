# community-ops-cloud

Runs Hirad's Community Ops PC jobs on GitHub Actions instead of the PC:
hourly Reddit/Steam history + team-site build, and the daily 08:15 full Trends pull.
The Python scripts themselves stay in the Google Drive folder "Community Ops - Reddit drops" and are downloaded on every run.

Secrets: `GOOGLE_SA_JSON` (same service-account key as the Cloudflare Worker), `CLOUDFLARE_API_TOKEN` (Pages: Edit), `CLOUDFLARE_ACCOUNT_ID`.
Variables: `PUSH` (1 = write history files back to Drive), `DEPLOY` (off / preview / production).
