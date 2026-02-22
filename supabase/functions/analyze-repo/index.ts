import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GITHUB_API = "https://api.github.com";

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

async function fetchIssues(owner: string, repo: string) {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues?state=open&per_page=15`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return [];
    const issues = await res.json();
    return issues.map((i: any) => ({
      title: i.title,
      labels: i.labels?.map((l: any) => l.name) ?? [],
      state: i.state,
      comments: i.comments,
      url: i.html_url,
    }));
  } catch {
    return [];
  }
}

async function fetchRepoStats(owner: string, repo: string) {
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { owner, repo } = await req.json();
    if (!owner || !repo) {
      return new Response(
        JSON.stringify({ error: "Please provide owner and repo" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    // Fetch all GitHub data in parallel
    const [readme, issues, stats] = await Promise.all([
      fetchReadme(owner, repo),
      fetchIssues(owner, repo),
      fetchRepoStats(owner, repo),
    ]);

    if (!stats) {
      return new Response(
        JSON.stringify({ error: `Repository ${owner}/${repo} not found or inaccessible.` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
  ? issues.map((i: any, idx: number) =>
      `${idx + 1}. **${i.title}** — Labels: [${i.labels.join(", ") || "none"}] — Comments: ${i.comments}`
    ).join("\n")
  : "No open issues found."}`;

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
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
      }
    );

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI usage limit reached. Please add credits." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(
        JSON.stringify({ error: "AI analysis failed." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("analyze-repo error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
