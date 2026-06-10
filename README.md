# HubSpot → Meta CAPI Offline Conversion Tracking

Cloudflare Worker that runs daily, pulls HubSpot contacts updated in the last 7 days, deduplicates against a D1 SQL database, and fires offline conversion events to Meta Conversions API.

## Events

| HubSpot lifecycle stage | Meta event |
|---|---|
| `opportunity` | `QualifiedLead` (custom) |
| `customer` | `Purchase` (standard) |

Revenue (`total_revenue`) is sent as event value on `Purchase` events in USD. Event timestamp uses the date the contact entered that lifecycle stage (`hs_date_entered_opportunity` / `hs_date_entered_customer`), falling back to `lastmodifieddate`.

---

## How it works

1. Runs daily at 06:00 UTC via cron trigger
2. Fetches contacts from HubSpot modified in the last 7 days, filtered by lifecycle stage
3. Deduplicates against a D1 database — contacts already sent are skipped
4. Hashes PII (email, phone) before sending to Meta
5. Fires events to Meta Conversions API
6. Marks successfully sent contacts in D1 to prevent re-sending

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

### 3. Cloudflare — set up bindings

**D1 database**

Create a D1 database from the Cloudflare dashboard or via Wrangler:

```bash
npx wrangler d1 create your-database-name
```

Then create the required tables:

```bash
npx wrangler d1 execute your-database-name --command "
CREATE TABLE sent_contacts (
  contact_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  event_time TEXT,
  has_fbc INTEGER DEFAULT 0,
  has_phone INTEGER DEFAULT 0,
  value REAL,
  PRIMARY KEY (contact_id, stage)
);
CREATE TABLE run_logs (
  timestamp TEXT PRIMARY KEY,
  opp_contacts INTEGER,
  opp_new INTEGER,
  opp_skipped INTEGER,
  opp_received INTEGER,
  cust_contacts INTEGER,
  cust_new INTEGER,
  cust_skipped INTEGER,
  cust_received INTEGER,
  errors TEXT
);"
```

Update `wrangler.toml` with your database name and ID:

```toml
[[d1_databases]]
binding = "DB"
database_name = "your-database-name"
database_id = "your-database-id"
```

**KV namespace**

Create a KV namespace for lightweight run summaries:

```toml
[[kv_namespaces]]
binding = "CAPI_LOGS"
id = "your-kv-namespace-id"
```

### 4. Deploy

Connect this repo to Cloudflare Workers via git, or deploy directly:

```bash
npx wrangler deploy
```

### 5. Set secrets

Workers & Pages > your worker > Settings > Variables > Add secret

| Secret | Value |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | From step 1 |
| `META_PIXEL_ID` | From step 2 |
| `META_ACCESS_TOKEN` | From step 2 |
| `META_TEST_EVENT_CODE` | From Events Manager > Test Events (remove once confirmed working) |

### 6. Verify cron trigger

Cloudflare dashboard > your worker > Triggers > Cron triggers

Should show `0 6 * * *` (daily at 06:00 UTC). If not, add it manually.

---

## Testing

Trigger a manual sync:

```
https://your-worker.workers.dev/run
```

Check results in:
- Cloudflare dashboard > Workers > Logs
- Meta Events Manager > Test Events (while `META_TEST_EVENT_CODE` is set)

Once events are landing correctly, remove `META_TEST_EVENT_CODE` from secrets to go live.

**Before your first live run**, hit `/reset` to clear any contacts sent during testing — otherwise the deduplication will skip them.

---

## Endpoints

| Endpoint | Description |
|---|---|
| `/run` | Trigger a manual sync — returns plain text log |
| `/contacts` | HTML table of sent contacts (filterable by stage, FBC; sortable) |
| `/logs` | Last 30 run records as JSON |
| `/reset` | Flush all deduplication records — use before first live run |

---

## Contact properties used

| Property | Notes |
|---|---|
| `email` | Required — contacts without email are skipped |
| `phone` | Optional match key — hashed before sending |
| `hs_facebook_click_id` | Optional — sent raw as `fbc` (not hashed) |
| `total_revenue` | Included as value on Purchase events (USD) |
| `lifecyclestage` | Filter: `opportunity` or `customer` |
| `lastmodifieddate` | Lookback filter — contacts modified in last 7 days |
| `hs_date_entered_opportunity` | Used as event timestamp for QualifiedLead events |
| `hs_date_entered_customer` | Used as event timestamp for Purchase events |
