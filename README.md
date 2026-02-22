
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

