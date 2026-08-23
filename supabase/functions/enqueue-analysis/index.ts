import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-idempotency-key, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const KAFKA_REST_URL = Deno.env.get("KAFKA_REST_URL") ?? "";
const KAFKA_USERNAME = Deno.env.get("KAFKA_USERNAME") ?? "";
const KAFKA_PASSWORD = Deno.env.get("KAFKA_PASSWORD") ?? "";
const KAFKA_TOPIC_MAIN = Deno.env.get("KAFKA_TOPIC_MAIN") ?? "analysis-jobs";
const MAX_ATTEMPTS = Number(Deno.env.get("ANALYSIS_MAX_ATTEMPTS") ?? "3");
const RETRY_BASE_DELAY_SECONDS = Number(Deno.env.get("ANALYSIS_RETRY_BASE_DELAY_SECONDS") ?? "30");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidSegment(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function buildKafkaHeaders() {
  const headers = {
    "Content-Type": "application/vnd.kafka.json.v2+json",
    Accept: "application/vnd.kafka.v2+json",
  } as Record<string, string>;

  if (KAFKA_USERNAME && KAFKA_PASSWORD) {
    headers.Authorization = "Basic " + btoa(`${KAFKA_USERNAME}:${KAFKA_PASSWORD}`);
  }

  return headers;
}

async function postgrest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { ok: response.ok, status: response.status, data };
}

async function publishKafka(topic: string, messageKey: string, value: Record<string, unknown>) {
  const response = await fetch(`${KAFKA_REST_URL}/topics/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: buildKafkaHeaders(),
    body: JSON.stringify({
      records: [{ key: messageKey, value }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Kafka publish failed (${response.status}): ${errorBody || "unknown error"}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Database is not configured" }, 500);
  }
  if (!KAFKA_REST_URL) {
    return jsonResponse({ error: "KAFKA_REST_URL is not configured" }, 500);
  }

  const idempotencyKey = req.headers.get("x-idempotency-key")?.trim() ?? "";
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return jsonResponse({ error: "Invalid x-idempotency-key format" }, 400);
  }

  try {
    const body = await req.json();
    const owner = typeof body?.owner === "string" ? body.owner.trim() : "";
    const repoRaw = typeof body?.repo === "string" ? body.repo.trim() : "";
    const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
    const requester = req.headers.get("x-client-info") ?? "unknown";

    if (!owner || !repo || !isValidSegment(owner) || !isValidSegment(repo)) {
      return jsonResponse({ error: "Please provide valid owner and repo" }, 400);
    }

    if (idempotencyKey) {
      const existingKey = await postgrest(
        `analysis_idempotency_keys?key=eq.${encodeURIComponent(idempotencyKey)}&select=key,status,request_id,response_markdown&limit=1`,
      );
      const row = Array.isArray(existingKey.data) ? existingKey.data[0] : null;
      if (row?.status === "processing" || row?.status === "queued") {
        return jsonResponse({
          status: "processing",
          requestId: row.request_id ?? null,
          message: "Request already queued or processing",
        }, 202);
      }
      if (row?.status === "completed") {
        return jsonResponse({
          status: "completed",
          requestId: row.request_id ?? null,
          cached: true,
          analysis: row.response_markdown ?? null,
        }, 200);
      }
    }

    const created = await postgrest("analysis_requests", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        owner,
        repo,
        requester,
        status: "queued",
        idempotency_key: idempotencyKey || null,
      }),
    });

    if (!created.ok || !Array.isArray(created.data) || !created.data[0]?.id) {
      return jsonResponse({ error: "Failed to create analysis request", details: created.data }, 500);
    }

    const requestId = created.data[0].id as string;
    const messageKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`;

    const queueInsert = await postgrest("analysis_queue_jobs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        request_id: requestId,
        owner,
        repo,
        kafka_topic: KAFKA_TOPIC_MAIN,
        kafka_key: messageKey,
        status: "queued",
        attempt_count: 0,
        max_attempts: Math.max(1, Math.floor(MAX_ATTEMPTS)),
      }),
    });

    if (!queueInsert.ok || !Array.isArray(queueInsert.data) || !queueInsert.data[0]?.id) {
      await postgrest(`analysis_requests?id=eq.${requestId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "failed",
          error_message: "Failed to create queue job",
        }),
      });
      return jsonResponse({ error: "Failed to create queue job", details: queueInsert.data }, 500);
    }

    const queueJobId = queueInsert.data[0].id as string;

    if (idempotencyKey) {
      await postgrest("analysis_idempotency_keys?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key: idempotencyKey,
          owner,
          repo,
          request_id: requestId,
          status: "processing",
        }),
      });
    }

    const payload = {
      request_id: requestId,
      queue_job_id: queueJobId,
      owner,
      repo,
      idempotency_key: idempotencyKey || null,
      attempt: 0,
      max_attempts: Math.max(1, Math.floor(MAX_ATTEMPTS)),
      retry_base_delay_seconds: Math.max(1, Math.floor(RETRY_BASE_DELAY_SECONDS)),
      enqueued_at: new Date().toISOString(),
    };

    try {
      await publishKafka(KAFKA_TOPIC_MAIN, messageKey, payload);
      await postgrest(`analysis_queue_jobs?id=eq.${queueJobId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          last_published_topic: KAFKA_TOPIC_MAIN,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Kafka publish failed";
      await postgrest(`analysis_queue_jobs?id=eq.${queueJobId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "failed",
          last_error: message,
        }),
      });
      await postgrest(`analysis_requests?id=eq.${requestId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "failed",
          error_message: message,
        }),
      });
      return jsonResponse({ error: "Failed to publish job to Kafka", details: message }, 502);
    }

    return jsonResponse({
      requestId,
      queueJobId,
      status: "queued",
      topic: KAFKA_TOPIC_MAIN,
    }, 202);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});
