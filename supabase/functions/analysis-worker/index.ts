import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-worker-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GITHUB_API = "https://api.github.com";
const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";
const WORKER_SHARED_SECRET = Deno.env.get("WORKER_SHARED_SECRET") ?? "";

const KAFKA_REST_URL = Deno.env.get("KAFKA_REST_URL") ?? "";
const KAFKA_USERNAME = Deno.env.get("KAFKA_USERNAME") ?? "";
const KAFKA_PASSWORD = Deno.env.get("KAFKA_PASSWORD") ?? "";
const KAFKA_TOPIC_RETRY = Deno.env.get("KAFKA_TOPIC_RETRY") ?? "analysis-jobs-retry";
const KAFKA_TOPIC_DLQ = Deno.env.get("KAFKA_TOPIC_DLQ") ?? "analysis-jobs-dlq";

type GitHubIssueApi = {
  title?: string;
  labels?: Array<{ name?: string }>;
  state?: string;
  comments?: number;
  html_url?: string;
};

type GitHubIssue = {
  title: string;
  labels: string[];
  state: string;
  comments: number;
  url: string;
};

type GitHubStats = {
  stars: number;
  forks: number;
  open_issues: number;
  language: string | null;
  license: string;
  last_updated: string;
  description: string | null;
  topics: string[];
};

type WorkerPayload = {
  request_id: string;
  queue_job_id: string;
  owner: string;
  repo: string;
  idempotency_key?: string | null;
  attempt?: number;
  max_attempts?: number;
  retry_base_delay_seconds?: number;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

async function publishKafka(topic: string, messageKey: string, value: Record<string, unknown>) {
  if (!KAFKA_REST_URL) throw new Error("KAFKA_REST_URL is not configured");

  const response = await fetch(`${KAFKA_REST_URL}/topics/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: buildKafkaHeaders(),
    body: JSON.stringify({
      records: [{ key: messageKey, value }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kafka publish failed (${response.status}): ${body || "unknown error"}`);
  }
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

async function fetchReadme(owner: string, repo: string): Promise<string> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, {
      headers: { Accept: "application/vnd.github.raw" },
    });
    if (!res.ok) return "README not found.";
    return (await res.text()).substring(0, 6000);
  } catch {
    return "Failed to fetch README.";
  }
}

async function fetchIssues(owner: string, repo: string): Promise<GitHubIssue[]> {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues?state=open&per_page=15`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return [];
    const issues = await res.json() as GitHubIssueApi[];
    return issues.map((issue) => ({
      title: issue.title ?? "Untitled issue",
      labels: issue.labels?.map((label) => label.name ?? "unknown") ?? [],
      state: issue.state ?? "open",
      comments: issue.comments ?? 0,
      url: issue.html_url ?? "",
    }));
  } catch {
    return [];
  }
}

async function fetchRepoStats(owner: string, repo: string): Promise<GitHubStats | null> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      stars: data.stargazers_count,
      forks: data.forks_count,
      open_issues: data.open_issues_count,
      language: data.language,
      license: data.license?.spdx_id ?? "None",
      last_updated: data.updated_at,
      description: data.description,
      topics: data.topics ?? [],
    };
  } catch {
    return null;
  }
}

async function parseAiStream(response: Response): Promise<string> {
  if (!response.body) throw new Error("No response stream from AI gateway");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const content = parsed.choices?.[0]?.delta?.content;
        if (typeof content === "string") result += content;
      } catch {
        // Ignore malformed chunks.
      }
    }
  }

  return result.trim();
}

async function runAnalysis(owner: string, repo: string) {
  const [readme, issues, stats] = await Promise.all([
    fetchReadme(owner, repo),
    fetchIssues(owner, repo),
    fetchRepoStats(owner, repo),
  ]);

  if (!stats) {
    throw new Error(`Repository ${owner}/${repo} not found or inaccessible.`);
  }

  const systemPrompt = `You are a Senior CNCF Architect & Open Source Maintainer. Analyze the given GitHub repository data and provide a comprehensive, structured analysis.

You MUST format your response using these exact sections with markdown:

## 🏗️ Project Overview
Summarize purpose and goals.

## ⚙️ Tech Stack Analysis
Identify languages, frameworks, tools.

## 🧩 Architecture Pattern
Identify: Microservices / Monolith / Operator / CLI / Library / Framework / etc.

## 📊 Repository Health Score: X/100
Score 0-100 considering: stars, recent activity, open issues, beginner issues, README quality. Justify clearly.

## 🐛 Good First Issues
List issues labeled "good first issue", "help wanted", "beginner". If none, say so.

## 🎯 Contribution Difficulty: [Easy/Medium/Hard]
Explain reasoning.

## 🚀 Open Source Onboarding Plan
Step-by-step beginner guide to contribute to this project.`;

  const userContent = `Analyze this GitHub repository: **${owner}/${repo}**

**Repository Stats:**
- ⭐ Stars: ${stats.stars}
- 🍴 Forks: ${stats.forks}
- 🐛 Open Issues: ${stats.open_issues}
- 💻 Language: ${stats.language}
- 📜 License: ${stats.license}
- 📅 Last Updated: ${stats.last_updated}
- 📝 Description: ${stats.description}
- 🏷️ Topics: ${stats.topics.join(", ") || "None"}

**README (first 6000 chars):**
\`\`\`
${readme}
\`\`\`

**Open Issues (up to 15):**
${issues.length > 0
  ? issues.map((issue, idx) => `${idx + 1}. **${issue.title}** — Labels: [${issue.labels.join(", ") || "none"}] — Comments: ${issue.comments}`).join("\n")
  : "No open issues found."}`;

  const aiResponse = await fetch(AI_GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + LOVABLE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      stream: true,
    }),
  });

  if (!aiResponse.ok) {
    const gatewayError = await aiResponse.text();
    throw new Error(gatewayError || `AI analysis failed with status ${aiResponse.status}`);
  }

  const analysisMarkdown = await parseAiStream(aiResponse);
  if (!analysisMarkdown) throw new Error("AI analysis returned empty output");
  return { readme, issues, stats, analysisMarkdown };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Database is not configured" }, 500);
  }
  if (!LOVABLE_API_KEY) {
    return jsonResponse({ error: "LOVABLE_API_KEY is not configured" }, 500);
  }
  if (WORKER_SHARED_SECRET && req.headers.get("x-worker-secret") !== WORKER_SHARED_SECRET) {
    return jsonResponse({ error: "Unauthorized worker request" }, 401);
  }

  try {
    const payload = await req.json() as WorkerPayload;
    if (!payload?.request_id || !payload?.queue_job_id || !payload?.owner || !payload?.repo) {
      return jsonResponse({ error: "Invalid worker payload" }, 400);
    }

    const attempt = Number.isFinite(payload.attempt) ? Number(payload.attempt) : 0;
    const maxAttempts = Number.isFinite(payload.max_attempts) ? Number(payload.max_attempts) : 3;
    const retryBaseDelaySeconds = Number.isFinite(payload.retry_base_delay_seconds)
      ? Number(payload.retry_base_delay_seconds)
      : 30;
    const idempotencyKey = payload.idempotency_key ?? null;
    const messageKey = `${payload.owner.toLowerCase()}/${payload.repo.toLowerCase()}`;

    await postgrest(`analysis_queue_jobs?id=eq.${payload.queue_job_id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "processing",
        attempt_count: attempt + 1,
      }),
    });

    await postgrest(`analysis_requests?id=eq.${payload.request_id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "processing" }),
    });

    try {
      const result = await runAnalysis(payload.owner, payload.repo);

      await postgrest(`analysis_requests?id=eq.${payload.request_id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "completed",
          from_cache: false,
          readme_excerpt: result.readme,
          github_issues: result.issues,
          github_stats: result.stats,
          analysis_markdown: result.analysisMarkdown,
          error_message: null,
        }),
      });

      await postgrest(`analysis_queue_jobs?id=eq.${payload.queue_job_id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "completed",
          last_error: null,
        }),
      });

      if (idempotencyKey) {
        await postgrest("analysis_idempotency_keys?on_conflict=key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            key: idempotencyKey,
            owner: payload.owner,
            repo: payload.repo,
            request_id: payload.request_id,
            status: "completed",
            response_markdown: result.analysisMarkdown,
          }),
        });
      }

      return jsonResponse({
        requestId: payload.request_id,
        queueJobId: payload.queue_job_id,
        status: "completed",
      }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      const nextAttempt = attempt + 1;

      if (nextAttempt < maxAttempts) {
        const retryDelaySeconds = Math.max(1, retryBaseDelaySeconds) * nextAttempt;
        const nextRetryAt = new Date(Date.now() + retryDelaySeconds * 1000).toISOString();
        const retryPayload = {
          ...payload,
          attempt: nextAttempt,
          failed_at: new Date().toISOString(),
          retry_after_seconds: retryDelaySeconds,
        };

        await publishKafka(KAFKA_TOPIC_RETRY, messageKey, retryPayload);

        await postgrest(`analysis_queue_jobs?id=eq.${payload.queue_job_id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "retrying",
            next_retry_at: nextRetryAt,
            last_error: message,
            last_published_topic: KAFKA_TOPIC_RETRY,
          }),
        });

        await postgrest(`analysis_requests?id=eq.${payload.request_id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "retrying",
            error_message: message,
          }),
        });

        if (idempotencyKey) {
          await postgrest("analysis_idempotency_keys?on_conflict=key", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              key: idempotencyKey,
              owner: payload.owner,
              repo: payload.repo,
              request_id: payload.request_id,
              status: "processing",
            }),
          });
        }

        return jsonResponse({
          requestId: payload.request_id,
          queueJobId: payload.queue_job_id,
          status: "retrying",
          attempt: nextAttempt,
          maxAttempts,
        }, 202);
      }

      const dlqPayload = {
        ...payload,
        attempt: nextAttempt,
        failed_at: new Date().toISOString(),
        error: message,
      };

      await publishKafka(KAFKA_TOPIC_DLQ, messageKey, dlqPayload);

      await postgrest(`analysis_queue_jobs?id=eq.${payload.queue_job_id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "dead_lettered",
          last_error: message,
          last_published_topic: KAFKA_TOPIC_DLQ,
        }),
      });

      await postgrest(`analysis_requests?id=eq.${payload.request_id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "dead_lettered",
          error_message: message,
        }),
      });

      await postgrest("analysis_dead_letter_events", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          queue_job_id: payload.queue_job_id,
          request_id: payload.request_id,
          owner: payload.owner,
          repo: payload.repo,
          payload: dlqPayload,
          error_message: message,
          attempts: nextAttempt,
        }),
      });

      if (idempotencyKey) {
        await postgrest("analysis_idempotency_keys?on_conflict=key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            key: idempotencyKey,
            owner: payload.owner,
            repo: payload.repo,
            request_id: payload.request_id,
            status: "failed",
          }),
        });
      }

      return jsonResponse({
        requestId: payload.request_id,
        queueJobId: payload.queue_job_id,
        status: "dead_lettered",
        attempts: nextAttempt,
        error: message,
      }, 200);
    }
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
