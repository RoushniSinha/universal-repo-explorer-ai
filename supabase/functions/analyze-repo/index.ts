import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-idempotency-key, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GITHUB_API = "https://api.github.com";
const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const CACHE_TTL_MS = 1000 * 60 * 30;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";

const hasDb = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

type GitHubIssue = {
  title: string;
  labels: string[];
  state: string;
  comments: number;
  url: string;
};

type GitHubIssueApi = {
  title?: string;
  labels?: Array<{ name?: string }>;
  state?: string;
  comments?: number;
  html_url?: string;
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

type AnalysisRequestRow = {
  id: string;
  created_at: string;
  analysis_markdown: string | null;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidSegment(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function toSSE(markdown: string) {
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: markdown } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  return new Response(payload, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
  });
}

async function postgrest(path: string, init: RequestInit = {}) {
  if (!hasDb) return { ok: false, status: 503, data: null };

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  let data: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { ok: response.ok, status: response.status, data };
}

async function logEvent(
  level: "info" | "warn" | "error",
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {},
  requestId?: string,
) {
  console[level === "error" ? "error" : "log"](`[${eventType}] ${message}`, metadata);

  if (!hasDb) return;

  await postgrest("agent_event_logs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      request_id: requestId ?? null,
      level,
      event_type: eventType,
      message,
      metadata,
    }),
  });
}

async function fetchReadme(owner: string, repo: string): Promise<string> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, {
      headers: { Accept: "application/vnd.github.raw" },
    });
    if (!res.ok) return "README not found.";
    const text = await res.text();
    return text.substring(0, 6000);
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
    if (!res.ok) throw new Error("Repo not found");
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
        // Ignore malformed partial chunks.
      }
    }
  }

  return result.trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let requestId: string | undefined;
  const idempotencyKey = req.headers.get("x-idempotency-key")?.trim() ?? "";

  try {
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      return jsonResponse({ error: "Invalid x-idempotency-key format" }, 400);
    }

    const body = await req.json();
    const owner = typeof body?.owner === "string" ? body.owner.trim() : "";
    const repoRaw = typeof body?.repo === "string" ? body.repo.trim() : "";
    const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;

    if (!owner || !repo || !isValidSegment(owner) || !isValidSegment(repo)) {
      return jsonResponse({ error: "Please provide valid owner and repo" }, 400);
    }

    const requester = req.headers.get("x-client-info") ?? "unknown";
    const now = Date.now();

    if (idempotencyKey && hasDb) {
      const existingKeyRes = await postgrest(
        `analysis_idempotency_keys?key=eq.${encodeURIComponent(idempotencyKey)}&select=key,status,response_markdown,expires_at,request_id&limit=1`,
      );

      const existingKey = Array.isArray(existingKeyRes.data) ? existingKeyRes.data[0] : null;

      if (existingKey) {
        const expiresAt = existingKey.expires_at ? Date.parse(existingKey.expires_at) : Number.POSITIVE_INFINITY;
        if (expiresAt > now && existingKey.status === "completed" && existingKey.response_markdown) {
          await logEvent("info", "idempotency.cache_hit", "Returning cached idempotent response", {
            owner,
            repo,
            idempotencyKey,
          }, existingKey.request_id ?? undefined);
          return toSSE(existingKey.response_markdown);
        }

        if (existingKey.status === "processing") {
          return jsonResponse({ error: "A request with this idempotency key is already processing" }, 409);
        }
      }

      await postgrest("analysis_idempotency_keys?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key: idempotencyKey,
          owner,
          repo,
          status: "processing",
          expires_at: new Date(now + CACHE_TTL_MS).toISOString(),
        }),
      });
    }

    const requestInsert = hasDb
      ? await postgrest("analysis_requests", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          owner,
          repo,
          requester,
          status: "processing",
          idempotency_key: idempotencyKey || null,
        }),
      })
      : null;

    const requestRow = requestInsert && Array.isArray(requestInsert.data)
      ? requestInsert.data[0] as AnalysisRequestRow
      : null;

    requestId = requestRow?.id;

    await logEvent("info", "analysis.request_received", "Analysis request accepted", {
      owner,
      repo,
      requester,
      idempotency: Boolean(idempotencyKey),
    }, requestId);

    if (hasDb) {
      const recentCache = await postgrest(
        `analysis_requests?owner=eq.${encodeURIComponent(owner)}&repo=eq.${encodeURIComponent(repo)}&status=eq.completed&select=id,created_at,analysis_markdown&order=created_at.desc&limit=1`,
      );

      const recent = Array.isArray(recentCache.data) ? recentCache.data[0] as AnalysisRequestRow : null;
      if (recent?.analysis_markdown && Date.now() - Date.parse(recent.created_at) <= CACHE_TTL_MS) {
        await postgrest(`analysis_requests?id=eq.${requestId}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "completed",
            from_cache: true,
            analysis_markdown: recent.analysis_markdown,
          }),
        });

        if (idempotencyKey) {
          await postgrest("analysis_idempotency_keys?on_conflict=key", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              key: idempotencyKey,
              owner,
              repo,
              request_id: requestId,
              status: "completed",
              response_markdown: recent.analysis_markdown,
              expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
            }),
          });
        }

        await logEvent("info", "analysis.cache_hit", "Returned cached analysis result", {
          owner,
          repo,
          cache_request_id: recent.id,
        }, requestId);

        return toSSE(recent.analysis_markdown);
      }
    }

    const [readme, issues, stats] = await Promise.all([
      fetchReadme(owner, repo),
      fetchIssues(owner, repo),
      fetchRepoStats(owner, repo),
    ]);

    if (!stats) {
      if (requestId && hasDb) {
        await postgrest(`analysis_requests?id=eq.${requestId}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "failed",
            readme_excerpt: readme,
            github_issues: issues,
            error_message: `Repository ${owner}/${repo} not found or inaccessible.`,
          }),
        });
      }

      return jsonResponse({ error: `Repository ${owner}/${repo} not found or inaccessible.` }, 404);
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

    if (requestId && hasDb) {
      await postgrest(`analysis_requests?id=eq.${requestId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          readme_excerpt: readme,
          github_stats: stats,
          github_issues: issues,
        }),
      });
    }

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

      if (requestId && hasDb) {
        await postgrest(`analysis_requests?id=eq.${requestId}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ status: "failed", error_message: gatewayError || "AI analysis failed." }),
        });
      }

      await logEvent("error", "analysis.ai_gateway_error", "AI analysis gateway request failed", {
        owner,
        repo,
        status: aiResponse.status,
      }, requestId);

      if (aiResponse.status === 429) {
        return jsonResponse({ error: "Rate limit exceeded. Please try again later." }, 429);
      }
      if (aiResponse.status === 402) {
        return jsonResponse({ error: "AI usage limit reached. Please add credits." }, 402);
      }
      return jsonResponse({ error: "AI analysis failed." }, 500);
    }

    const analysisMarkdown = await parseAiStream(aiResponse);

    if (!analysisMarkdown) {
      throw new Error("AI analysis returned empty output");
    }

    if (requestId && hasDb) {
      await postgrest(`analysis_requests?id=eq.${requestId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "completed",
          analysis_markdown: analysisMarkdown,
          from_cache: false,
        }),
      });
    }

    if (idempotencyKey && hasDb) {
      await postgrest("analysis_idempotency_keys?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key: idempotencyKey,
          owner,
          repo,
          request_id: requestId,
          status: "completed",
          response_markdown: analysisMarkdown,
          expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
        }),
      });
    }

    await logEvent("info", "analysis.completed", "Analysis completed", {
      owner,
      repo,
      output_chars: analysisMarkdown.length,
    }, requestId);

    return toSSE(analysisMarkdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (requestId && hasDb) {
      await postgrest(`analysis_requests?id=eq.${requestId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "failed", error_message: message }),
      });
    }

    if (idempotencyKey && hasDb) {
      await postgrest("analysis_idempotency_keys?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          key: idempotencyKey,
          status: "failed",
          expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
        }),
      });
    }

    await logEvent("error", "analysis.failed", "Analysis failed", { message }, requestId);
    return jsonResponse({ error: message }, 500);
  }
});
