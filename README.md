# HubSpot → Meta CAPI Offline Conversion Tracking

Cloudflare Worker that runs daily, pulls HubSpot contacts updated in the last 7 days, deduplicates against KV, and fires offline conversion events to Meta Conversions API.

## Events

| HubSpot lifecycle stage | Meta event |
|---|---|
| `opportunity` | `QualifiedLead` (custom) |
| `customer` | `Purchase` (standard) |

Revenue (`total_revenue`) is included as event value on `Purchase` events. Event timestamp uses the date the contact entered that lifecycle stage (`hs_date_entered_opportunity` / `hs_date_entered_customer`), falling back to `lastmodifieddate`.

---

## Endpoints

| Endpoint | Description |
|---|---|
| `/run` | Trigger a manual sync — returns plain text log |
| `/logs` | Last 30 run records as JSON |
| `/contacts?stage=opportunity` | All sent contacts for a stage with enriched data |
| `/contacts?stage=customer` | As above for customer stage |
| `/reset` | Flush all dedup keys — use before first live run |

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

Workers & Pages > hstometa > Settings > Variables > Add secret

| Secret name | Value |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | From step 1 |
| `META_PIXEL_ID` | From step 2 |
| `META_ACCESS_TOKEN` | From step 2 |
| `META_TEST_EVENT_CODE` | From Events Manager > Test Events (remove once confirmed working) |

### 4. KV namespace

Create a KV namespace (any name) and bind it to the worker as `CAPI_LOGS`. The namespace ID should be set in `wrangler.toml`.

Workers & Pages > hstometa > Settings > KV namespace bindings > Add binding

| Variable name | KV namespace |
|---|---|
| `CAPI_LOGS` | your namespace |

### 5. Verify cron trigger

Cloudflare dashboard > hstometa > Triggers > Cron triggers

Should show `0 6 * * *` (daily at 06:00 UTC). If not, add it manually.

---

## Going live

1. Test with `META_TEST_EVENT_CODE` set and confirm events appear in Meta Events Manager > Test Events
2. Hit `/reset` to flush any dedup keys written during testing
3. Remove `META_TEST_EVENT_CODE` from secrets
4. Hit `/run` — all contacts within the lookback window will fire as live events

---

## Contact properties used

| Property | Notes |
|---|---|
| `email` | Required — contacts without email are skipped |
| `phone` | Optional match key — hashed before sending |
| `hs_facebook_click_id` | Optional — sent raw as `fbc` (Meta does not want it hashed) |
| `total_revenue` | Included as value on Purchase events (USD) |
| `lifecyclestage` | Filter: `opportunity` or `customer` |
| `lastmodifieddate` | Lookback filter — contacts modified in last 7 days |
| `hs_date_entered_opportunity` | Used as event timestamp for QualifiedLead events |
| `hs_date_entered_customer` | Used as event timestamp for Purchase events |

---

## KV storage

Each sent contact is stored as `sent:{stage}:{contact_id}` with a 60-day expiry. The value is a JSON record:

```json
{
  "sent_at": "2026-06-09T17:00:00.000Z",
  "event_time": "2026-05-01T09:00:00.000Z",
  "has_fbc": true,
  "has_phone": false,
  "value": 4632
}
```

Run logs are stored as `run:{timestamp}` and indexed under the `index` key (last 30 retained).
