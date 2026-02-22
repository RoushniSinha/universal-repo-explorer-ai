import { useState, useMemo } from "react";
import { GitBranch, Search, Loader2, AlertCircle, Sparkles, Github, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { useToast } from "@/hooks/use-toast";

const ANALYZE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-repo`;

const sectionIcons: Record<string, string> = {
  "Project Overview": "🏗️",
  "Tech Stack Analysis": "⚙️",
  "Architecture Pattern": "🧩",
  "Repository Health Score": "📊",
  "Good First Issues": "🐛",
  "Contribution Difficulty": "🎯",
  "Open Source Onboarding Plan": "🚀",
};

function parseSections(md: string) {
  const lines = md.split("\n");
  const sections: { icon: string; title: string; content: string }[] = [];
  let current: { icon: string; title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(?:[\u{1F000}-\u{1FFFF}]\s*)?(.+)/u);
    if (h2Match) {
      if (current) sections.push({ icon: current.icon, title: current.title, content: current.lines.join("\n").trim() });
      const rawTitle = h2Match[1].trim();
      const icon = Object.entries(sectionIcons).find(([k]) => rawTitle.includes(k))?.[1] || "📄";
      current = { icon, title: rawTitle, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      // Content before first heading
      if (line.trim()) {
        if (!sections.length || sections[sections.length - 1].title !== "") {
          sections.push({ icon: "📋", title: "", content: "" });
        }
        sections[sections.length - 1].content += line + "\n";
      }
    }
  }
  if (current) sections.push({ icon: current.icon, title: current.title, content: current.lines.join("\n").trim() });
  return sections;
}

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
      {children}
      <ExternalLink className="h-3 w-3 inline shrink-0" />
    </a>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold text-foreground mt-5 mb-2 flex items-center gap-2">{children}</h3>
  ),
  ul: ({ children }) => (
    <ul className="space-y-2 my-3 list-disc pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="space-y-2 my-3 list-decimal pl-5">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="text-muted-foreground leading-relaxed">{children}</li>
  ),
  p: ({ children }) => (
    <p className="text-muted-foreground leading-relaxed mb-3">{children}</p>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return <code className={`${className} block bg-muted/50 p-4 rounded-lg overflow-x-auto text-sm`}>{children}</code>;
    }
    return <code className="text-primary bg-primary/10 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>;
  },
};

const Index = () => {
  const [repoInput, setRepoInput] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();
  const analysisSections = useMemo(() => parseSections(analysis), [analysis]);

  const handleAnalyze = async () => {
    setError("");
    setAnalysis("");

    const match = repoInput.trim().match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+)\/?$/);
    if (!match) {
      setError("Invalid format. Use owner/repo or a GitHub URL.");
      return;
    }

    const [, owner, repo] = match;
    setIsLoading(true);

    try {
      const resp = await fetch(ANALYZE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ owner, repo }),
      });

      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.error || "Analysis failed");
      }

      if (!resp.body) throw new Error("No response stream");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              result += content;
              setAnalysis(result);
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (e: any) {
      const msg = e.message || "Something went wrong";
      setError(msg);
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto flex items-center justify-between py-4 px-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <GitBranch className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">CNCF-Architect Pro</h1>
              <p className="text-xs text-muted-foreground">AI-Powered Repository Analyzer</p>
            </div>
          </div>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <Github className="h-5 w-5" />
          </a>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Hero */}
        {!analysis && !isLoading && (
          <div className="text-center py-16 space-y-4">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium mb-4">
              <Sparkles className="h-4 w-4" />
              Powered by AI
            </div>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight">
              Analyze Any GitHub Repo
            </h2>
            <p className="text-lg text-muted-foreground max-w-xl mx-auto">
              Get instant insights on tech stack, architecture, health score, and contribution opportunities.
            </p>
          </div>
        )}

        {/* Example Chips */}
        {!analysis && !isLoading && (
          <div className="flex flex-wrap justify-center gap-2 mb-6 max-w-2xl mx-auto">
            {["kubernetes/kubernetes", "facebook/react", "denoland/deno", "vercel/next.js", "supabase/supabase"].map((r) => (
              <button
                key={r}
                onClick={() => setRepoInput(r)}
                className="px-3 py-1.5 text-sm rounded-full border border-border bg-card hover:bg-accent hover:text-accent-foreground transition-colors text-muted-foreground"
              >
                {r}
              </button>
            ))}
          </div>
        )}

        {/* Search */}
        <div className="flex gap-2 mb-8 max-w-2xl mx-auto">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="owner/repo or GitHub URL..."
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !isLoading && handleAnalyze()}
              className="pl-10 h-12 bg-card border-border text-base"
            />
          </div>
          <Button onClick={handleAnalyze} disabled={isLoading || !repoInput.trim()} size="lg" className="h-12 px-6">
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Analyze"}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <Card className="border-destructive/50 bg-destructive/5 mb-6 max-w-2xl mx-auto">
            <CardContent className="flex items-center gap-3 py-4">
              <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Loading */}
        {isLoading && !analysis && (
          <div className="flex flex-col items-center gap-4 py-16">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground">Fetching repository data & running AI analysis...</p>
          </div>
        )}

        {/* Analysis Result */}
        {analysis && (
          <div className="space-y-5">
            {analysisSections.map((section, idx) => (
              <Card key={idx} className="border-border bg-card overflow-hidden">
                {section.title && (
                  <CardHeader className="border-b border-border bg-muted/30 py-4 px-6">
                    <CardTitle className="text-lg font-semibold flex items-center gap-2.5">
                      <span className="text-xl">{section.icon}</span>
                      {section.title}
                    </CardTitle>
                  </CardHeader>
                )}
                <CardContent className="py-5 px-6">
                  <ReactMarkdown components={markdownComponents}>{section.content}</ReactMarkdown>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default Index;
