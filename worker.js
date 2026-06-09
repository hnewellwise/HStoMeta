/**
 * Cloudflare Worker: HubSpot → Meta CAPI Offline Conversion Tracking
 *
 * Runs on a daily cron trigger at 06:00 UTC.
 * Fetches HubSpot contacts modified in the last 30 days where
 * lifecyclestage = 'opportunity' or 'customer', deduplicates against KV,
 * then fires the appropriate event to Meta Conversions API.
 *
 * Environment variables (set as secrets in Cloudflare dashboard):
 *   HUBSPOT_ACCESS_TOKEN   — HubSpot private app token
 *   META_PIXEL_ID          — Meta Pixel / Dataset ID
 *   META_ACCESS_TOKEN      — Meta CAPI access token (from Events Manager)
 *   META_TEST_EVENT_CODE   — (optional) remove once confirmed working in Events Manager
 *
 * KV Namespace binding:
 *   CAPI_LOGS              — bound to angama_capi_logs
 *
 * Endpoints:
 *   /run   — trigger a manual sync, returns plain text log
 *   /logs  — returns last 30 run records as JSON
 *   /reset — deletes all sent: dedup keys (use before first live run)
 */

const HUBSPOT_SEARCH_URL = "https://api.hubapi.com/crm/v3/objects/contacts/search";
const META_CAPI_URL = (pixelId) => `https://graph.facebook.com/v18.0/${pixelId}/events`;

const EVENT_MAP = {
  opportunity: "QualifiedLead",
  customer: "Purchase",
};

const CONTACT_PROPERTIES = [
  "email",
  "phone",
  "hs_facebook_click_id",
  "total_revenue",
  "lifecyclestage",
  "lastmodifieddate",
];

const LOOKBACK_DAYS = 7;

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const logs = [];
      await runSync(env, logs);
      return new Response(logs.join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/reset") {
      try {
        let deleted = 0;
        let cursor = undefined;
        do {
          const result = await env.CAPI_LOGS.list({ prefix: "sent:", cursor, limit: 1000 });
          await Promise.all(result.keys.map((k) => env.CAPI_LOGS.delete(k.name)));
          deleted += result.keys.length;
          cursor = result.list_complete ? undefined : result.cursor;
        } while (cursor);
        return new Response(`Reset complete — deleted ${deleted} sent keys`, { status: 200 });
      } catch (err) {
        return new Response(`Reset error: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/logs") {
      try {
        const indexRaw = await env.CAPI_LOGS.get("index");
        if (!indexRaw) return new Response("No logs yet", { status: 200 });
        const index = JSON.parse(indexRaw);
        const runs = await Promise.all(
          index.slice().reverse().map(async (key) => {
            const val = await env.CAPI_LOGS.get(key);
            return val ? JSON.parse(val) : null;
          })
        );
        return new Response(JSON.stringify(runs.filter(Boolean), null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(`Error reading logs: ${err.message}`, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// ─── Main sync ────────────────────────────────────────────────────────────────

async function runSync(env, logs = []) {
  const log = (msg) => { console.log(msg); logs.push(msg); };
  const since = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const runTimestamp = new Date().toISOString();

  log(`Run started — lookback: ${LOOKBACK_DAYS} days (since ${new Date(since).toISOString()})`);

  const runRecord = {
    timestamp: runTimestamp,
    opportunity: { contacts: 0, new: 0, skipped: 0, meta_received: 0 },
    customer: { contacts: 0, new: 0, skipped: 0, meta_received: 0 },
    errors: [],
  };

  for (const stage of ["opportunity", "customer"]) {
    await sleep(5000);
    log(`\n--- Stage: ${stage} ---`);

    let contacts;
    try {
      contacts = await fetchHubSpotContacts(env, stage, since);
    } catch (err) {
      const msg = `ERROR fetching contacts [${stage}]: ${err.message}`;
      log(msg);
      runRecord.errors.push(msg);
      continue;
    }

    log(`Contacts found: ${contacts.length}`);
    runRecord[stage].contacts = contacts.length;
    if (contacts.length === 0) continue;

    // Deduplicate against KV
    const { fresh, skipped } = await deduplicateContacts(env, contacts, stage);
    runRecord[stage].new = fresh.length;
    runRecord[stage].skipped = skipped;
    log(`New: ${fresh.length}, Already sent: ${skipped}`);
    if (fresh.length === 0) continue;

    // Build and send events
    const events = await buildMetaEvents(fresh, stage, log);
    if (events.length === 0) continue;

    const received = await sendToMetaCAPI(env, events, stage, log);
    runRecord[stage].meta_received = received;

    // Only mark as sent if Meta accepted them
    if (received > 0) {
      await markAsSent(env, fresh, stage);
    }
  }

  log("\nRun complete.");
  await writeRunLog(env, runTimestamp, runRecord, logs);
}

// ─── KV deduplication ─────────────────────────────────────────────────────────

async function deduplicateContacts(env, contacts, stage) {
  // Fetch all sent keys for this stage in one list call — avoids per-contact subrequests
  const sentKeys = new Set();
  let cursor = undefined;

  do {
    const result = await env.CAPI_LOGS.list({
      prefix: `sent:${stage}:`,
      cursor,
      limit: 1000,
    });
    for (const key of result.keys) sentKeys.add(key.name);
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  const fresh = [];
  let skipped = 0;

  for (const contact of contacts) {
    const key = `sent:${stage}:${contact.id}`;
    if (sentKeys.has(key)) {
      skipped++;
    } else {
      fresh.push(contact);
    }
  }

  return { fresh, skipped };
}

async function markAsSent(env, contacts, stage) {
  const timestamp = new Date().toISOString();
  // Write in batches of 20 to stay within subrequest limits
  const chunks = chunkArray(contacts, 20);
  for (const chunk of chunks) {
    await Promise.all(
      chunk.map((contact) =>
        env.CAPI_LOGS.put(`sent:${stage}:${contact.id}`, timestamp, {
          expirationTtl: 60 * 24 * 60 * 60,
        })
      )
    );
  }
}

// ─── Run logging ──────────────────────────────────────────────────────────────

async function writeRunLog(env, timestamp, record, logs) {
  try {
    await env.CAPI_LOGS.put(`run:${timestamp}`, JSON.stringify(record));

    const indexRaw = await env.CAPI_LOGS.get("index");
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    index.push(`run:${timestamp}`);

    if (index.length > 30) {
      const toDelete = index.splice(0, index.length - 30);
      for (const key of toDelete) await env.CAPI_LOGS.delete(key);
    }

    await env.CAPI_LOGS.put("index", JSON.stringify(index));
    logs.push(`Logged to KV: ${timestamp}`);
  } catch (err) {
    logs.push(`KV write error: ${err.message}`);
  }
}

// ─── HubSpot ──────────────────────────────────────────────────────────────────

async function fetchHubSpotContacts(env, stage, sinceMs) {
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: "lifecyclestage", operator: "EQ", value: stage },
          { propertyName: "lastmodifieddate", operator: "GTE", value: sinceMs },
        ],
      },
    ],
    properties: CONTACT_PROPERTIES,
    limit: 100,
  };

  let allContacts = [];
  let after = undefined;

  do {
    if (after) {
      body.after = after;
      // Pause between paginated requests to avoid rate limit
      await sleep(1000);
    }

    const response = await fetch(HUBSPOT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`HubSpot ${response.status}: ${err}`);
    }

    const data = await response.json();
    allContacts = allContacts.concat(data.results || []);
    after = data.paging?.next?.after;
  } while (after);

  return allContacts;
}

// ─── Event builder ────────────────────────────────────────────────────────────

async function buildMetaEvents(contacts, stage, log) {
  const events = [];

  for (const contact of contacts) {
    const props = contact.properties;
    const email = props.email?.trim().toLowerCase();

    if (!email) {
      log(`Skipping contact ${contact.id} — no email`);
      continue;
    }

    const userData = {
      em: [await sha256(email)],
    };

    if (props.phone) {
      const cleanPhone = props.phone.replace(/[^0-9]/g, "");
      if (cleanPhone) userData.ph = [await sha256(cleanPhone)];
    }

    // fbclid sent raw — Meta does not want it hashed
    if (props.hs_facebook_click_id) {
      userData.fbc = props.hs_facebook_click_id;
    }

    const eventTime = props.lastmodifieddate
      ? Math.floor(new Date(props.lastmodifieddate).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const event = {
      event_name: EVENT_MAP[stage],
      event_time: eventTime,
      action_source: "system_generated",
      user_data: userData,
    };

    if (stage === "customer") {
      const revenue = props.total_revenue ? parseFloat(props.total_revenue) : 0;
      event.custom_data = { value: revenue || 0, currency: "EUR" };
    }

    events.push(event);
  }

  return events;
}

// ─── Meta CAPI ────────────────────────────────────────────────────────────────

async function sendToMetaCAPI(env, events, stage, log) {
  const chunks = chunkArray(events, 1000);
  let totalReceived = 0;

  for (const chunk of chunks) {
    const payload = {
      data: chunk,
      access_token: env.META_ACCESS_TOKEN,
    };

    if (env.META_TEST_EVENT_CODE) {
      payload.test_event_code = env.META_TEST_EVENT_CODE;
    }

    const response = await fetch(META_CAPI_URL(env.META_PIXEL_ID), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      log(`Meta CAPI error: ${JSON.stringify(result)}`);
    } else {
      log(`Meta CAPI success — events received: ${result.events_received}, trace ID: ${result.fbtrace_id}`);
      totalReceived += result.events_received || 0;
    }
  }

  return totalReceived;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function sha256(value) {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
