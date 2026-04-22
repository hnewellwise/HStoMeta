/**
 * Cloudflare Worker: HubSpot → Meta CAPI Offline Conversion Tracking
 *
 * Runs on a daily cron trigger at 06:00 UTC.
 * Fetches HubSpot contacts updated in the last 24 hours where
 * lifecyclestage = 'opportunity' or 'customer', then fires the
 * appropriate event to Meta Conversions API.
 *
 * Environment variables (set as secrets in Cloudflare dashboard):
 *   HUBSPOT_ACCESS_TOKEN   — HubSpot private app token
 *   META_PIXEL_ID          — Meta Pixel / Dataset ID
 *   META_ACCESS_TOKEN      — Meta CAPI access token (from Events Manager)
 *   META_TEST_EVENT_CODE   — (optional) remove once confirmed working in Events Manager
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
  "hs_lastmodifieddate",
];

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  // Cron trigger — runs daily at 06:00 UTC
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  // HTTP trigger — hit /run to fire manually (useful for testing)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      ctx.waitUntil(runSync(env));
      return new Response("Sync triggered", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  },
};

// ─── Main sync ────────────────────────────────────────────────────────────────

async function runSync(env) {
  const since = Date.now() - 24 * 60 * 60 * 1000;

  for (const stage of ["opportunity", "customer"]) {
    let contacts;

    try {
      contacts = await fetchHubSpotContacts(env, stage, since);
    } catch (err) {
      console.error(`[${stage}] Failed to fetch contacts:`, err.message);
      continue;
    }

    console.log(`[${stage}] ${contacts.length} contacts found`);
    if (contacts.length === 0) continue;

    const events = await buildMetaEvents(contacts, stage);
    console.log(`[${stage}] ${events.length} valid events after filtering`);
    if (events.length === 0) continue;

    await sendToMetaCAPI(env, events, stage);
  }
}

// ─── HubSpot ──────────────────────────────────────────────────────────────────

async function fetchHubSpotContacts(env, stage, sinceMs) {
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: "lifecyclestage", operator: "EQ", value: stage },
          { propertyName: "hs_lastmodifieddate", operator: "GTE", value: sinceMs },
        ],
      },
    ],
    properties: CONTACT_PROPERTIES,
    limit: 100,
  };

  let allContacts = [];
  let after = undefined;

  do {
    if (after) body.after = after;

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

async function buildMetaEvents(contacts, stage) {
  const events = [];

  for (const contact of contacts) {
    const props = contact.properties;
    const email = props.email?.trim().toLowerCase();

    if (!email) {
      console.warn(`Skipping contact ${contact.id} — no email`);
      continue;
    }

    const userData = {
      em: [await sha256(email)],
    };

    if (props.phone) {
      const cleanPhone = props.phone.replace(/[^0-9]/g, "");
      if (cleanPhone) userData.ph = [await sha256(cleanPhone)];
    }

    // fbclid is sent raw — Meta does not want it hashed
    if (props.hs_facebook_click_id) {
      userData.fbc = props.hs_facebook_click_id;
    }

    const eventTime = props.hs_lastmodifieddate
      ? Math.floor(new Date(props.hs_lastmodifieddate).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const event = {
      event_name: EVENT_MAP[stage],
      event_time: eventTime,
      action_source: "crm",
      user_data: userData,
    };

    // Only send value on Purchase events where revenue is present
    if (stage === "customer" && props.total_revenue) {
      const revenue = parseFloat(props.total_revenue);
      if (revenue > 0) {
        event.custom_data = { value: revenue, currency: "EUR" };
      }
    }

    events.push(event);
  }

  return events;
}

// ─── Meta CAPI ────────────────────────────────────────────────────────────────

async function sendToMetaCAPI(env, events, stage) {
  const chunks = chunkArray(events, 1000);

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
      console.error(`[${stage}] Meta CAPI error:`, JSON.stringify(result));
    } else {
      console.log(
        `[${stage}] Sent ${chunk.length} events — ` +
        `received: ${result.events_received}, ` +
        `trace ID: ${result.fbtrace_id}`
      );
    }
  }
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

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
