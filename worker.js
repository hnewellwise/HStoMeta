/**
 * Cloudflare Worker: HubSpot → Meta CAPI Offline Conversion Tracking
 *
 * Runs daily at 06:00 UTC. Fetches HubSpot contacts modified in the last
 * 7 days, deduplicates against D1, fires events to Meta Conversions API.
 *
 * Bindings:
 *   DB         — D1 database (hstometa) — deduplication + run logs
 *   CAPI_LOGS  — KV namespace — lightweight daily run summary only
 *
 * Secrets:
 *   HUBSPOT_ACCESS_TOKEN
 *   META_PIXEL_ID
 *   META_ACCESS_TOKEN
 *   META_TEST_EVENT_CODE  (optional — remove once live)
 *
 * Endpoints:
 *   /run       — manual sync, plain text log
 *   /contacts  — HTML table of sent contacts (?stage=, ?fbc=1, ?sort=, ?dir=)
 *   /logs      — last 30 runs as JSON
 *   /preview   — dry run: fetch + dedup only, no Meta send, no D1 writes
 *   /reset     — delete all sent_contacts rows from D1
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
  "firstname",
  "lastname",
  "ip_city",
  "country",
  "hs_facebook_click_id",
  "total_revenue",
  "lifecyclestage",
  "lastmodifieddate",
  "hs_v2_date_entered_opportunity",
  "hs_v2_date_entered_customer",
];

const LOOKBACK_DAYS = 7;

const VALID_SORT_COLS = ["contact_id", "stage", "sent_at", "event_time", "has_fbc", "has_phone", "value"];

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (env.WORKER_TOKEN && url.searchParams.get("token") !== env.WORKER_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/run") {
      const logs = [];
      await runSync(env, logs);
      return new Response(logs.join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/preview") {
      const logs = [];
      const log = (msg) => { console.log(msg); logs.push(msg); };
      const since = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      log(`Preview — lookback: ${LOOKBACK_DAYS} days (since ${new Date(since).toISOString()})\n`);

      for (const stage of ["opportunity", "customer"]) {
        await sleep(5000);
        log(`--- Stage: ${stage} ---`);
        let contacts;
        try {
          contacts = await fetchHubSpotContacts(env, stage, since);
        } catch (err) {
          log(`ERROR: ${err.message}`);
          continue;
        }
        const dateProp = stage === "customer"
          ? "hs_v2_date_entered_customer"
          : "hs_v2_date_entered_opportunity";

        log(`Contacts found: ${contacts.length}`);
        const filtered = filterByStageDate(contacts, stage, since);
        const excluded = contacts.filter((c) => !filtered.includes(c));
        log(`Stage-date filter: ${filtered.length} pass, ${excluded.length} excluded`);

        if (excluded.length > 0) {
          log(`\n  [EXCLUDED — stage date outside lookback window]`);
          for (const c of excluded) {
            const props = c.properties;
            log(`  ${c.id} | email: ${props.email || "—"} | stage date: ${props[dateProp] || "no date"} | last modified: ${props.lastmodifieddate || "—"}`);
          }
        }

        contacts = filtered;
        if (contacts.length === 0) { log(""); continue; }

        const { fresh, skipped } = await deduplicateContacts(env, contacts, stage);
        log(`\n  [WILL SEND]`);
        log(`New: ${fresh.length}, Already sent: ${skipped}`);

        for (const c of fresh) {
          const props = c.properties;
          log(`  ${c.id} | email: ${props.email || "—"} | stage date: ${props[dateProp] || "—"} | fbc: ${props.hs_facebook_click_id ? "yes" : "no"} | value: ${props.total_revenue || "—"}`);
        }

        if (skipped > 0) {
          log(`\n  [SKIPPED — already in D1]`);
          const sentIds = new Set(fresh.map((c) => c.id));
          for (const c of contacts.filter((c) => !sentIds.has(c.id))) {
            log(`  ${c.id} | email: ${c.properties.email || "—"}`);
          }
        }
        log("");
      }

      log("Preview complete — nothing sent.");
      return new Response(logs.join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/contacts") {
      return handleContactsPage(request, env);
    }

    if (url.pathname === "/logs") {
      return handleLogs(env);
    }

    if (url.pathname === "/reset") {
      return handleReset(env);
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
    contacts = filterByStageDate(contacts, stage, since);
    log(`After stage-date filter: ${contacts.length}`);
    runRecord[stage].contacts = contacts.length;
    if (contacts.length === 0) continue;

    const { fresh, skipped } = await deduplicateContacts(env, contacts, stage);
    runRecord[stage].new = fresh.length;
    runRecord[stage].skipped = skipped;
    log(`New: ${fresh.length}, Already sent: ${skipped}`);
    if (fresh.length === 0) continue;

    const { events, validContacts } = await buildMetaEvents(fresh, stage, log);
    if (events.length === 0) continue;

    const received = await sendToMetaCAPI(env, events, stage, log);
    runRecord[stage].meta_received = received;

    if (received > 0) {
      await markAsSent(env, validContacts, stage, events);
    }
  }

  log("\nRun complete.");
  await writeRunLog(env, runTimestamp, runRecord, logs);
}

// ─── D1 deduplication ─────────────────────────────────────────────────────────

async function deduplicateContacts(env, contacts, stage) {
  const { results } = await env.DB.prepare(
    "SELECT contact_id FROM sent_contacts WHERE stage = ?"
  ).bind(stage).all();

  const sentIds = new Set(results.map((r) => r.contact_id));

  const fresh = [];
  let skipped = 0;

  for (const contact of contacts) {
    if (sentIds.has(contact.id)) {
      skipped++;
    } else {
      fresh.push(contact);
    }
  }

  return { fresh, skipped };
}

async function markAsSent(env, contacts, stage, events) {
  const sentAt = new Date().toISOString();

  const stmts = contacts.map((contact, i) => {
    const event = events[i];
    const props = contact.properties;
    return env.DB.prepare(
      `INSERT OR REPLACE INTO sent_contacts
       (contact_id, stage, sent_at, event_time, has_fbc, has_phone, value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      contact.id,
      stage,
      sentAt,
      event ? new Date(event.event_time * 1000).toISOString() : null,
      props.hs_facebook_click_id ? 1 : 0,
      props.phone?.replace(/[^0-9]/g, "") ? 1 : 0,
      props.total_revenue ? parseFloat(props.total_revenue) : null
    );
  });

  // D1 batch: max 100 statements per call
  const chunks = chunkArray(stmts, 100);
  for (const chunk of chunks) {
    await env.DB.batch(chunk);
  }
}

// ─── Run logging ──────────────────────────────────────────────────────────────

async function writeRunLog(env, timestamp, record, logs) {
  try {
    // D1: full structured record
    await env.DB.prepare(
      `INSERT OR REPLACE INTO run_logs
       (timestamp, opp_contacts, opp_new, opp_skipped, opp_received,
        cust_contacts, cust_new, cust_skipped, cust_received, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      timestamp,
      record.opportunity.contacts,
      record.opportunity.new,
      record.opportunity.skipped,
      record.opportunity.meta_received,
      record.customer.contacts,
      record.customer.new,
      record.customer.skipped,
      record.customer.meta_received,
      JSON.stringify(record.errors)
    ).run();

    // KV: lightweight summary — 1 write per run, stays within free tier
    await env.CAPI_LOGS.put(`run:${timestamp}`, JSON.stringify({
      timestamp,
      opp_new: record.opportunity.new,
      opp_received: record.opportunity.meta_received,
      cust_new: record.customer.new,
      cust_received: record.customer.meta_received,
      errors: record.errors.length,
    }));

    logs.push(`Logged to D1 + KV: ${timestamp}`);
  } catch (err) {
    logs.push(`Log write error: ${err.message}`);
  }
}

// ─── /contacts — HTML table ───────────────────────────────────────────────────

async function handleContactsPage(request, env) {
  const url = new URL(request.url);
  const stage = url.searchParams.get("stage") || "all";
  const fbcOnly = url.searchParams.get("fbc") === "1";
  const sortCol = VALID_SORT_COLS.includes(url.searchParams.get("sort"))
    ? url.searchParams.get("sort")
    : "sent_at";
  const sortDir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";

  const where = [];
  const binds = [];
  if (stage !== "all") { where.push("stage = ?"); binds.push(stage); }
  if (fbcOnly) where.push("has_fbc = 1");
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rowsResult, countsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM sent_contacts ${whereClause} ORDER BY ${sortCol} ${sortDir}`
    ).bind(...binds).all(),
    env.DB.prepare(
      "SELECT stage, COUNT(*) as n FROM sent_contacts GROUP BY stage"
    ).all(),
  ]);

  const countMap = {};
  for (const c of countsResult.results) countMap[c.stage] = c.n;
  const total = Object.values(countMap).reduce((a, b) => a + b, 0);
  const oppCount = countMap["opportunity"] || 0;
  const custCount = countMap["customer"] || 0;

  const qs = (overrides) => {
    const p = new URLSearchParams({ stage, fbc: fbcOnly ? "1" : "0", sort: sortCol, dir: sortDir.toLowerCase(), ...overrides });
    return "?" + p.toString();
  };

  const sortArrow = (col) => {
    if (col !== sortCol) return "";
    return sortDir === "DESC" ? " ↓" : " ↑";
  };

  const sortLink = (col, label) => {
    const newDir = col === sortCol && sortDir === "DESC" ? "asc" : "desc";
    return `<a href="${qs({ sort: col, dir: newDir })}">${label}${sortArrow(col)}</a>`;
  };

  const tableRows = rowsResult.results.length
    ? rowsResult.results.map((r) => `
      <tr>
        <td class="mono">${r.contact_id}</td>
        <td><span class="badge badge-${r.stage === "opportunity" ? "opp" : "cust"}">${r.stage}</span></td>
        <td>${r.sent_at ? r.sent_at.replace("T", " ").slice(0, 19) : "—"}</td>
        <td>${r.event_time ? r.event_time.replace("T", " ").slice(0, 19) : "—"}</td>
        <td class="center">${r.has_fbc ? '<span class="tick">✓</span>' : '<span class="cross">—</span>'}</td>
        <td class="center">${r.has_phone ? '<span class="tick">✓</span>' : '<span class="cross">—</span>'}</td>
        <td class="right">${r.value != null ? "$" + Number(r.value).toLocaleString() : "—"}</td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="empty">No records found</td></tr>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CAPI Contacts</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f4f5; color: #18181b; font-size: 14px; }
    .header { background: #fff; border-bottom: 1px solid #e4e4e7; padding: 16px 24px; }
    h1 { font-size: 16px; font-weight: 600; }
    .stats { font-size: 13px; color: #71717a; margin-top: 4px; }
    .controls { background: #fff; border-bottom: 1px solid #e4e4e7; padding: 10px 24px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .tab { padding: 5px 14px; border-radius: 6px; font-size: 13px; border: 1px solid #e4e4e7; background: #fff; color: #52525b; text-decoration: none; }
    .tab:hover { border-color: #a1a1aa; color: #18181b; }
    .tab.active { background: #18181b; color: #fff; border-color: #18181b; }
    .fbc-filter { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-left: auto; color: #52525b; cursor: pointer; }
    .fbc-filter input { cursor: pointer; accent-color: #18181b; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; background: #fff; min-width: 680px; }
    th { padding: 9px 16px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #71717a; border-bottom: 1px solid #e4e4e7; white-space: nowrap; }
    th a { color: inherit; text-decoration: none; }
    th a:hover { color: #18181b; }
    td { padding: 9px 16px; border-bottom: 1px solid #f4f4f5; color: #3f3f46; font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }
    .mono { font-family: ui-monospace, monospace; font-size: 12px; color: #71717a; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
    .badge-opp { background: #eff6ff; color: #1d4ed8; }
    .badge-cust { background: #f0fdf4; color: #15803d; }
    .tick { color: #16a34a; font-weight: 600; }
    .cross { color: #d4d4d8; }
    .center { text-align: center; }
    .right { text-align: right; font-variant-numeric: tabular-nums; }
    .empty { text-align: center; padding: 48px; color: #a1a1aa; }
  </style>
</head>
<body>
  <div class="header">
    <h1>CAPI Sent Contacts</h1>
    <div class="stats">${total.toLocaleString()} total &middot; ${oppCount.toLocaleString()} opportunity &middot; ${custCount.toLocaleString()} customer</div>
  </div>
  <div class="controls">
    <a href="${qs({ stage: "all" })}" class="tab ${stage === "all" ? "active" : ""}">All</a>
    <a href="${qs({ stage: "opportunity" })}" class="tab ${stage === "opportunity" ? "active" : ""}">Opportunity</a>
    <a href="${qs({ stage: "customer" })}" class="tab ${stage === "customer" ? "active" : ""}">Customer</a>
    <label class="fbc-filter">
      <input type="checkbox" ${fbcOnly ? "checked" : ""}
        onchange="location.href='${qs({ fbc: "FBCVAL" })}'.replace('FBCVAL', this.checked ? '1' : '0')">
      FBC only
    </label>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>${sortLink("contact_id", "Contact ID")}</th>
          <th>${sortLink("stage", "Stage")}</th>
          <th>${sortLink("sent_at", "Sent At")}</th>
          <th>${sortLink("event_time", "Event Time")}</th>
          <th class="center">${sortLink("has_fbc", "FBC")}</th>
          <th class="center">${sortLink("has_phone", "Phone")}</th>
          <th class="right">${sortLink("value", "Value")}</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ─── /logs ────────────────────────────────────────────────────────────────────

async function handleLogs(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM run_logs ORDER BY timestamp DESC LIMIT 30"
  ).all();
  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── /reset ───────────────────────────────────────────────────────────────────

async function handleReset(env) {
  try {
    const { meta } = await env.DB.prepare("DELETE FROM sent_contacts").run();
    return new Response(`Reset complete — deleted ${meta.changes} rows`, { status: 200 });
  } catch (err) {
    return new Response(`Reset error: ${err.message}`, { status: 500 });
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
  const validContacts = [];

  for (const contact of contacts) {
    const props = contact.properties;
    const email = props.email?.trim().toLowerCase();

    if (!email) {
      log(`Skipping contact ${contact.id} — no email`);
      continue;
    }

    const userData = {
      em: await sha256(email),
      external_id: await sha256(contact.id),
    };

    if (props.phone) {
      const cleanPhone = props.phone.replace(/[^0-9]/g, "");
      if (cleanPhone) userData.ph = await sha256(cleanPhone);
    }

    if (props.firstname) userData.fn = await sha256(props.firstname.trim().toLowerCase());
    if (props.lastname) userData.ln = await sha256(props.lastname.trim().toLowerCase());
    if (props.ip_city) userData.ct = await sha256(props.ip_city.trim().toLowerCase().replace(/\s/g, ""));
    if (props.country) userData.country = await sha256(props.country.trim().toLowerCase());

    if (props.hs_facebook_click_id) {
      userData.fbc = props.hs_facebook_click_id;
    }

    const stageDate = stage === "customer"
      ? props.hs_v2_date_entered_customer
      : props.hs_v2_date_entered_opportunity;

    const eventTime = Math.floor(
      new Date(stageDate || Date.now()).getTime() / 1000
    );

    const event = {
      event_name: EVENT_MAP[stage],
      event_time: eventTime,
      event_id: `${contact.id}_${stage}`,
      action_source: "system_generated",
      user_data: userData,
    };

    if (stage === "customer") {
      const revenue = props.total_revenue ? parseFloat(props.total_revenue) : 0;
      event.custom_data = { value: parseFloat((revenue || 0).toFixed(2)), currency: "USD" };
    }

    events.push(event);
    validContacts.push(contact);
  }

  return { events, validContacts };
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

function filterByStageDate(contacts, stage, sinceMs) {
  const dateProp = stage === "customer"
    ? "hs_v2_date_entered_customer"
    : "hs_v2_date_entered_opportunity";
  return contacts.filter((c) => {
    const val = c.properties[dateProp];
    if (!val) return false;
    return new Date(val).getTime() >= sinceMs;
  });
}

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
