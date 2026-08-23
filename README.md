
# 🤖 CNCF-Architect Pro: Universal AI Repository Agent

**CNCF-Architect Pro** is a repository-agnostic autonomous agent designed to streamline open-source onboarding and project analysis. Built as a Capstone Project for the **Microsoft Elevate AICTE Internship (2026)**, it utilizes **Gemini 1.5 Flash** to analyze any public GitHub repository and provide structured, actionable intelligence.
## 🔗 Live Demo
**Project URL:** [https://universal-repo-explorer-ai.vercel.app](https://universal-repo-explorer-ai.vercel.app)


![CNCF-Architect Dashboard](https://github.com/RoushniSinha/universal-repo-explorer-ai/blob/main/public/ms%20project%20result%203.png)
![result](https://github.com/RoushniSinha/universal-repo-explorer-ai/blob/3ee09397f726f37f0d3e4374d0e055ab4e1ffbd6/public/ms%20project%20result%205.png)
[*all the other images are here!](https://github.com/RoushniSinha/universal-repo-explorer-ai/tree/main/public)

[*the ppt presentation of document is here](https://github.com/RoushniSinha/universal-repo-explorer-ai/blob/main/CNCF-Architect-Pro(universal%20repo%20explorer)-Roushni_Sinha.pdf)

## 📖 About the Project: How it Works
This project implements a **Deterministic Agentic Loop** to solve the problem of developer onboarding in complex ecosystems. Unlike standard LLM chatbots, this agent achieves its results through:

1. **Autonomous Tooling:** The agent does not "guess." It uses a **ReAct (Reasoning and Acting)** framework to call specific GitHub API tools to gather raw data before responding.
2. **Context Injection:** It fetches the raw `README.md` and repo metadata, injecting this live context into the **Gemini 1.5 Flash** context window, ensuring the analysis is never based on outdated training data.
3. **Automated Scoring:** It uses a weighted algorithm to evaluate repository health by analyzing real-time telemetry (commit frequency, issue-to-star ratio, and active maintainer labels).
## 🚀 Key Features

* **Autonomous Tool Orchestration:** Unlike simple chatbots, this agent uses **Function Calling** to programmatically fetch live telemetry from the GitHub REST API.
* **Universal Repo Exploration:** Seamlessly analyzes any public repository to extract tech stacks, architectural patterns, and onboarding guides.
* **CloudNative Maturity Scoring:** Implements a custom algorithm to calculate a **Maturity Score (0-100)** based on repository velocity, documentation quality, and ecosystem trust.
* **Contributor Roadmap:** Specifically identifies `good first issue` and `help wanted` labels to generate a step-by-step roadmap for new contributors.

---

## 🛠️ Tech Stack

* **LLM Engine:** Google Gemini 1.5 Flash (via `@ai-sdk/google`)
* **Framework:** Next.js 15 (App Router), TypeScript, Tailwind CSS
* **Agentic Logic:** Vercel AI SDK for deterministic tool calling
* **Deployment:** Vercel Edge Runtime for low-latency streaming

---

## 🧠 The Agentic Algorithm

The system follows a **ReAct (Reasoning and Acting)** pattern:

1. **Analyze:** The agent parses the user's repository URL or name.
2. **Act:** It triggers three concurrent tools:
* `analyzeRepo`: Fetches and summarizes raw README content.
* `fetchIssues`: Scans for beginner-friendly labels.
* `fetchRepoStats`: Retrieves stars, forks, and update frequency.


3. **Synthesize:** The LLM evaluates the gathered data against CNCF maturity standards to produce a structured analysis card.

---

## 📦 Getting Started

### 1. Prerequisites

* Node.js 18+
* Google AI Studio API Key (Gemini)

### 2. Installation

```bash
git clone https://github.com/RoushniSinha/universal-repo-explorer-ai.git
cd universal-repo-explorer-ai
npm install

```

### 3. Environment Setup

Create a `.env.local` file in the root:

```env
GOOGLE_GENERATIVE_AI_API_KEY=your_key_here

```

### 4. Run Locally

```bash
npm run dev

```

---

## 📄 License & Acknowledgments

Developed as part of the **MCA Capstone Project** and the **MS Elevate AICTE Internship**.

**GitHub Link:** [https://github.com/RoushniSinha/universal-repo-explorer-ai](https://www.google.com/search?q=https://github.com/RoushniSinha/universal-repo-explorer-ai)



## 🔐 Backend Security & Persistence (Phase 1/2)

This project now includes hardened Supabase Edge Functions and persistence tables:

- `analyze-repo` requires JWT verification and supports request idempotency (`x-idempotency-key`).
- `get-analyses` exposes recent analysis history for a given `owner/repo`.
- Supabase migration adds:
  - `analysis_requests`
  - `analysis_idempotency_keys`
  - `agent_event_logs`

### Required Supabase Edge Function secrets

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
LOVABLE_API_KEY=...
```

## 🧵 Async Queue Processing (Phase 3: Kafka + Worker + Retry/DLQ)

Phase 3 adds asynchronous analysis orchestration using Kafka topics and a dedicated worker:

- `enqueue-analysis` (Edge Function): validates request, persists `analysis_requests`, creates `analysis_queue_jobs`, and publishes to Kafka.
- `analysis-worker` (Edge Function): processes a queued job, runs repository analysis, updates persistence tables, retries on transient failures, and routes terminal failures to DLQ.
- New database tables:
  - `analysis_queue_jobs`
  - `analysis_dead_letter_events`

### Required Phase 3 secrets

```bash
KAFKA_REST_URL=...
KAFKA_USERNAME=...            # optional
KAFKA_PASSWORD=...            # optional
KAFKA_TOPIC_MAIN=analysis-jobs
KAFKA_TOPIC_RETRY=analysis-jobs-retry
KAFKA_TOPIC_DLQ=analysis-jobs-dlq
ANALYSIS_MAX_ATTEMPTS=3
ANALYSIS_RETRY_BASE_DELAY_SECONDS=30
WORKER_SHARED_SECRET=...      # optional but recommended
```

### Recommended flow

1. Client calls `enqueue-analysis` with `owner/repo` (+ optional `x-idempotency-key`).
2. Kafka consumer invokes `analysis-worker` for each message in main/retry topics.
3. Worker:
   - marks job `processing`
   - completes analysis and marks `completed`, or
   - publishes to retry topic (attempt < max), or
   - publishes to DLQ and records `analysis_dead_letter_events` (attempt >= max).
