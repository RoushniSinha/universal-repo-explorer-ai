import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidSegment(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

async function postgrest(path: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "Database is not configured" }, 500);
    }

    const url = new URL(req.url);
    const owner = (url.searchParams.get("owner") ?? "").trim();
    const repo = (url.searchParams.get("repo") ?? "").trim();
    const limitInput = Number(url.searchParams.get("limit") ?? "10");
    const limit = Number.isFinite(limitInput) ? Math.min(Math.max(Math.floor(limitInput), 1), 50) : 10;

    if (!owner || !repo || !isValidSegment(owner) || !isValidSegment(repo)) {
      return jsonResponse({ error: "Please provide valid owner and repo query params" }, 400);
    }

    const query = [
      `analysis_requests?owner=eq.${encodeURIComponent(owner)}`,
      `repo=eq.${encodeURIComponent(repo)}`,
      "select=id,owner,repo,status,from_cache,analysis_markdown,created_at,updated_at,github_stats",
      "order=created_at.desc",
      `limit=${limit}`,
    ].join("&");

    const dbRes = await postgrest(query);
    if (!dbRes.ok) {
      return jsonResponse({ error: "Failed to fetch analysis history", details: dbRes.data }, dbRes.status || 500);
    }

    return jsonResponse({
      owner,
      repo,
      count: Array.isArray(dbRes.data) ? dbRes.data.length : 0,
      analyses: Array.isArray(dbRes.data) ? dbRes.data : [],
    });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
