# HubSpot → Meta CAPI Offline Conversion Tracking

Cloudflare Worker that runs daily, pulls HubSpot contacts updated in the last 24 hours, and fires offline conversion events to Meta Conversions API.

## Events

| HubSpot lifecycle stage | Meta event |
|---|---|
| `opportunity` | `QualifiedLead` (custom) |
| `customer` | `Purchase` (standard) |

Revenue (`total_revenue`) is included as event value on `Purchase` events.

---

## Setup

### 1. HubSpot — create a private app

1. HubSpot > Settings > Integrations > Private Apps > Create a private app
2. Give it a name (e.g. "Meta CAPI sync")
3. Scopes required: `crm.objects.contacts.read`
4. Copy the access token

### 2. Meta — get your CAPI credentials

1. Meta Events Manager > your pixel > Settings
2. Copy the **Dataset ID** (this is your Pixel ID)
3. Generate a **CAPI access token** from the same page

### 3. Cloudflare — connect repo and set secrets

1. Cloudflare dashboard > Workers & Pages > Create > Connect to Git
2. Select this repo, set branch to `main`
3. Framework preset: None. Build command: leave blank. Build output: leave blank.
4. Deploy

Then add secrets:

Workers & Pages > hubspot-meta-capi > Settings > Variables > Add secret

| Secret name | Value |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | From step 1 |
| `META_PIXEL_ID` | From step 2 |
| `META_ACCESS_TOKEN` | From step 2 |
| `META_TEST_EVENT_CODE` | From Events Manager > Test Events (remove once confirmed working) |

### 4. Verify cron trigger

Cloudflare dashboard > hubspot-meta-capi > Triggers > Cron triggers

Should show `0 6 * * *` (daily at 06:00 UTC). If not, add it manually.

---

## Testing

Hit the `/run` endpoint to trigger a manual sync:

```
https://hubspot-meta-capi.<your-subdomain>.workers.dev/run
```

Check results in:
- Cloudflare dashboard > Workers > Logs
- Meta Events Manager > Test Events (while `META_TEST_EVENT_CODE` is set)

Once you're seeing events land correctly in Test Events, remove `META_TEST_EVENT_CODE` from your secrets to go live.

---

## Contact properties used

| Property | Notes |
|---|---|
| `email` | Required — contacts without email are skipped |
| `phone` | Optional match key |
| `hs_facebook_click_id` | Optional — sent raw (not hashed) |
| `total_revenue` | Included as value on Purchase events |
| `lifecyclestage` | Filter: `opportunity` or `customer` |
| `hs_lastmodifieddate` | Filter: updated in last 24 hours |
