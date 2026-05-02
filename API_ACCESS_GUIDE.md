# Getting API Access: FACTS & Ministry Platform

**A concise next-steps guide for the parish/school operator. Print this, walk through it in order.**

---

## The Short Version

| | FACTS | Ministry Platform |
|---|---|---|
| **Cost** | $500/year | Included with platform |
| **Who initiates** | School admin | Parish IT/admin |
| **Time to get credentials** | 1–5 business days | Same-day (it's self-serve) |
| **Approval needed?** | Yes (FACTS Support issues) | No (operator creates them) |
| **What you'll receive** | Client ID, Client Secret, Access Token URL | Client ID, Client Secret |
| **Ongoing maintenance** | Renew annually | Rotate secret every 90–180 days (recommended) |

---

## FACTS — Step-by-Step

### Step 1. Confirm you have access to the right FACTS admin

You (or your school's FACTS admin) must be able to log into FACTS with the highest-tier admin role — the one that can see **System > Configuration > Integrations**. If you can't see that menu path, you're not the right user; find whoever set up FACTS for the school.

### Step 2. Verify OneRoster API Export is enabled on your FACTS tier

Once logged in:

1. Navigate to **System > Configuration > Integrations**
2. Look for **OneRoster** in the integrations list
3. Click into OneRoster and look for **API Export**

If you see an API Export option, you're good to proceed. If you don't, your FACTS tier may not include API access — you'll need to call FACTS Support (1-866-441-4637) and ask them to enable it on your account. They'll quote the $500/year fee at that point if it's not already included.

### Step 3. Submit the API Export request

Inside the OneRoster API Export panel:

1. Fill out the form (it asks who is requesting access and for what purpose — say "third-party identity ledger integration for school directory and family management")
2. Submit the form
3. **Expect a 1–5 business day turnaround.** FACTS Support reviews the request and emails the credentials to the school admin on file.

### Step 4. Receive and store the credentials

You'll get an email containing:

- **Client ID** (looks like a long string, sometimes UUID-shaped)
- **Client Secret** (a longer random string — treat this like a password)
- **API Base URL** (e.g., `https://schoolname.client.renweb.com/api/v3` — exact format varies)
- **Access Token URL** (the OAuth 2.0 token endpoint — usually the API Base URL with `/oauth2/token` appended)

**Store these somewhere secure immediately.** A password manager (1Password, Bitwarden) is fine. Do NOT email them to yourself in plaintext, and do NOT paste them into a Slack channel.

### Step 5. Verify with a test call before configuring Family Graph

Before plugging credentials into Family Graph, confirm they work. From a terminal:

```
cd ~/Downloads
curl -X POST "<your Access Token URL>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<your Client ID>" \
  -d "client_secret=<your Client Secret>"
```

You should get back a JSON response containing `access_token`, `token_type: bearer`, and `expires_in`. If you get a 401 or an error message, the credentials are wrong — go back to FACTS Support before troubleshooting Family Graph.

### Step 6. Configure in Family Graph

Once the test call works:

1. Open Family Graph dashboard at `http://127.0.0.1:3500`
2. Navigate to **Settings > Connectors**
3. Click **FACTS SIS**
4. Paste in the four values: API Base URL, Access Token URL, Client ID, Client Secret
5. Click **Test Connection** — expect `ok` within 10 seconds
6. Set the schedule (recommend Daily at 2 AM)
7. Toggle **Enabled** on
8. Click **Run Sync Now** to do an initial pull

You're done. The first sync of a typical 200-family school takes about 3–5 minutes.

### FACTS Gotchas

- **The $500 is per school, per year.** If you run Family Graph for multiple schools, each one needs its own subscription.
- **The credentials expire if you change FACTS tiers or migrate accounts.** Re-request from FACTS Support if you upgrade or move.
- **OneRoster doesn't expose tuition, billing, attendance, or discipline data.** Only roster (students, parents, classes, enrollments) and gradebook. If you need the other data, you're back to CSV exports — which Family Graph also supports.
- **The diocese requires FACTS as your SIS of record.** This integration doesn't change that — Family Graph reads from FACTS, never writes back. (Write-back is a planned future feature, but it'll always be operator-confirmed.)

---

## Ministry Platform — Step-by-Step

### Step 1. Confirm you have access to the right MP admin role

You need an MP user account with the **Administrators** security role (or a custom role with access to the **API Clients** page under Administration). If you don't have that, ask whoever administers MP at the parish.

### Step 2. Find your API base URL and Swagger console

Your Ministry Platform installation has its own domain. Two URLs you need to know:

- **API base URL:** `https://<your-mp-domain>/ministryplatformapi/`
- **Swagger console:** `https://<your-mp-domain>/ministryplatformapi/swagger`

Replace `<your-mp-domain>` with the actual domain your parish uses to log into MP — it's the same one you use for the staff portal. Open the Swagger URL in a browser to confirm it loads. If it doesn't, contact your MP support representative.

### Step 3. Create an API Client

Inside MP admin:

1. Navigate to **Administration > API Clients**
2. Click **New** to create a client
3. Fill in:
   - **Display Name:** `Family Graph` (or whatever's recognizable in audit logs)
   - **Client Type:** select the option for client credentials / server-to-server (varies by MP version; if asked between "Confidential" and "Public," choose Confidential)
   - **User:** select an MP user that has the security roles needed for the data you want to pull. Recommend creating a dedicated user named `family-graph-api` with a security role limited to read access on Households, Contacts, and Addresses.
4. Save the API Client. MP will generate a Client ID and Client Secret automatically.

### Step 4. Capture the credentials

After saving, MP shows you:

- **Client ID** (a string identifier)
- **Client Secret** (long random string — **MP only shows this once**, copy it immediately)

**If you lose the secret, you cannot retrieve it — you'll have to regenerate it, which invalidates the old one.** Store both in a password manager before navigating away from the page.

### Step 5. Verify with the Swagger console

Before plugging into Family Graph:

1. Open `https://<your-mp-domain>/ministryplatformapi/swagger`
2. Click the **Authorize** button at the top right
3. Choose the **client_credentials** flow
4. Paste in your Client ID and Client Secret
5. Click **Authorize** — should succeed silently
6. Try a simple call: expand any `GET /tables/Households` endpoint, click **Try it out**, click **Execute**
7. Expect a 200 response with a JSON array of households

If the Authorize step fails, the credentials are wrong (or the user attached to the API Client lacks permissions). If Authorize succeeds but the test query returns 403, the user's security role doesn't include the right pages — go back to step 3 and adjust.

### Step 6. Configure in Family Graph

Once Swagger confirms credentials work:

1. Open Family Graph dashboard at `http://127.0.0.1:3500`
2. Navigate to **Settings > Connectors**
3. Click **Ministry Platform**
4. Paste in: API Base URL, Client ID, Client Secret. (The OAuth Discovery URL is usually `<API Base URL>/oauth/connect/token` — Family Graph will auto-derive it if you leave that field blank.)
5. Click **Test Connection** — expect `ok` within 10 seconds
6. Set the schedule (recommend Daily at 2 AM)
7. Toggle **Enabled** on
8. Click **Run Sync Now** to do an initial pull

A typical parish of 1,500 households takes 10–15 minutes for the first sync. Subsequent syncs (incremental) finish in under a minute.

### Ministry Platform Gotchas

- **The user attached to the API Client controls what the API can see.** If you ever expand what data Family Graph reads (e.g., adding Contact Logs in a future version), you have to update the user's security role accordingly.
- **The secret should be rotated periodically.** MP doesn't enforce this, but security best practice is every 90–180 days. To rotate: open the API Client in MP admin, click "Generate New Secret," paste the new secret into Family Graph's connector settings, save.
- **MP custom fields are not pulled by default.** Different parishes customize Contacts and Households with parish-specific fields. The current Family Graph connector only reads standard fields. If your parish has custom fields you want to ingest, that's a future feature (custom field mapping editor — see PRD §8.1).
- **No additional fee.** API access is included with your existing MP subscription.

---

## What to do if either connector breaks

This isn't a long list. Most failures fall into one of three buckets:

### Bucket 1: "auth_failed"

The credentials Family Graph has don't work. Either:
- The secret was rotated externally (someone regenerated it in FACTS or MP without updating Family Graph)
- The user account attached to the API Client was disabled
- The subscription lapsed (FACTS only)

**Fix:** go back to the access steps above, regenerate or verify, paste the new values into Family Graph's connector settings.

### Bucket 2: "network_error"

Family Graph couldn't reach the API endpoint. Either:
- Internet is down
- The FACTS or MP service is having an outage
- A corporate firewall is blocking outbound HTTPS to the relevant domain

**Fix:** check `https://status.factsmgt.com` (FACTS) or your MP domain in a browser. If the service is up and your internet works, check with whoever runs your network for outbound HTTPS rules.

### Bucket 3: Everything else

Pull the operator status from the CLI:

```
cd ~/family-graph
node bin/family-graph.js connector status
```

That output, plus the relevant lines from `~/.family-graph/logs/server.log`, is everything you need to either fix it yourself or paste into a Claude Code session for help.

If a connector is broken and you need data NOW, remember: **file-based ingest still works.** Drop a CSV from FACTS or MP into `~/.family-graph/watch` and it flows through the same pipeline. The connectors are a convenience, not a dependency.

---

## Summary checklist

**FACTS (do this first if school is the priority):**
- [ ] Confirm you can access System > Configuration > Integrations in FACTS admin
- [ ] Submit OneRoster API Export request (expect 1–5 days)
- [ ] Pay the $500/year if not already on your subscription
- [ ] Receive Client ID, Client Secret, API Base URL, Access Token URL via email
- [ ] Test with `curl` from your terminal
- [ ] Configure in Family Graph at Settings > Connectors > FACTS SIS
- [ ] Run initial sync, verify families and persons appear in Family Graph

**Ministry Platform (do this in parallel — no wait time):**
- [ ] Confirm you have Administrators role in MP
- [ ] Verify Swagger console loads at `https://<your-mp-domain>/ministryplatformapi/swagger`
- [ ] Create dedicated `family-graph-api` user with read access to Households, Contacts, Addresses
- [ ] Create API Client in Administration > API Clients
- [ ] Copy Client ID and Client Secret immediately (MP only shows secret once)
- [ ] Test in Swagger console (Authorize, then GET /tables/Households)
- [ ] Configure in Family Graph at Settings > Connectors > Ministry Platform
- [ ] Run initial sync, verify households and contacts appear in Family Graph

Total active time on the operator's part: about 30 minutes for MP (same day), about 30 minutes for FACTS spread across the 1–5 day approval window.

---

*If anything in this guide is wrong or out of date when you actually go to do this, file an issue or update the doc. The vendors change their UIs more often than they update their public documentation.*

---

## Note on the underlying implementation

As of Phase 1 (PRD `PRD_LIVE_CONNECTORS.md`), the connector code is
shipped — what's left is the operator-side credential dance described
above. The CLI exposes the same operations the dashboard does, so you
can verify a connector before opening a browser:

```sh
node bin/family-graph.js connector status
node bin/family-graph.js connector test facts
node bin/family-graph.js connector sync facts
```

`connector test` issues a single read against the vendor (FACTS `/orgs`
or MP `/tables/Households` with `$top=1`) and writes nothing. `connector
sync` runs the full pull through the same import pipeline that file
ingest uses; it's safe to run repeatedly because the resolver
deduplicates by definitive signal (exact email/phone/strong address). If
something breaks, the most recent attempt is always one row in
`connector_runs` and one matching `import_runs` row, both visible from
the dashboard's Imports log.

