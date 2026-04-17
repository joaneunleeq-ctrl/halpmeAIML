// LLM Provider Abstraction Layer
// PRD §4.2: "Swapping from Ollama to Groq to OpenAI requires changing one
// environment variable, not application code."

export interface LLMCompletionParams {
  systemPrompt: string;
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
}

export interface LLMProvider {
  readonly name: string;
  complete(params: LLMCompletionParams): Promise<string>;
  healthCheck(): Promise<boolean>;
}

// ============================================================
// Ollama Provider (local inference, zero cost)
// ============================================================

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private baseUrl: string;
  private model: string;

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    this.model = process.env.OLLAMA_MODEL || "llama3.1:8b";
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const { systemPrompt, userMessage, temperature = 0.7, responseFormat } = params;

    const prompt = `${systemPrompt}\n\nUser: ${userMessage}`;
    const format = responseFormat === "json" ? "json" : undefined;

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature,
          num_predict: params.maxTokens || 2048,
        },
        ...(format && { format }),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.response;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================
// Groq Provider (free tier, cloud, fast inference)
// ============================================================

export class GroqProvider implements LLMProvider {
  readonly name = "groq";
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = process.env.GROQ_API_KEY || "";
    this.model = "llama-3.1-70b-versatile";
    if (!this.apiKey) {
      console.warn("GROQ_API_KEY not set — Groq provider will fail on requests");
    }
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const {
      systemPrompt,
      userMessage,
      temperature = 0.7,
      maxTokens = 2048,
      responseFormat,
    } = params;

    const body: Record<string, unknown> = {
      model: this.model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    };

    if (responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
      console.warn(`Groq rate limited, waiting ${waitMs}ms...`);
      await new Promise((r) => setTimeout(r, waitMs));
      return this.complete(params);
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================
// OpenAI Provider (paid, highest quality)
// ============================================================

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.model = "gpt-4o";
    if (!this.apiKey) {
      console.warn("OPENAI_API_KEY not set — OpenAI provider will fail on requests");
    }
  }

  async complete(params: LLMCompletionParams): Promise<string> {
    const {
      systemPrompt,
      userMessage,
      temperature = 0.7,
      maxTokens = 2048,
      responseFormat,
    } = params;

    const body: Record<string, unknown> = {
      model: this.model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    };

    if (responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI error (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================
// Factory: reads LLM_PROVIDER env var and returns the right provider
// ============================================================

let cachedProvider: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (cachedProvider) return cachedProvider;

  const provider = process.env.LLM_PROVIDER || "ollama";

  switch (provider) {
    case "ollama":
      cachedProvider = new OllamaProvider();
      break;
    case "groq":
      cachedProvider = new GroqProvider();
      break;
    case "openai":
      cachedProvider = new OpenAIProvider();
      break;
    default:
      throw new Error(
        `Unknown LLM_PROVIDER: "${provider}". Valid options: ollama, groq, openai`
      );
  }

  console.log(`LLM provider initialized: ${cachedProvider.name}`);
  return cachedProvider;
}
