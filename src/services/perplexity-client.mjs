function resolveApiKey(config = {}) {
  return config.apiKey
    || process.env.PERPLEXITY_API_KEY
    || process.env.LLM_API_KEY
    || "";
}

function parseMessageContent(content) {
  const text = Array.isArray(content)
    ? content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }

          if (part && typeof part.text === "string") {
            return part.text;
          }

          return "";
        })
        .join("\n")
    : String(content || "");

  const trimmed = text.trim();
  if (!trimmed) {
    return {
      text: "",
      json: null
    };
  }

  try {
    return {
      text: trimmed,
      json: JSON.parse(trimmed)
    };
  } catch {
    return {
      text: trimmed,
      json: null
    };
  }
}

export async function askPerplexity({
  question,
  apiKey,
  baseUrl = "https://api.perplexity.ai",
  model = "sonar",
  systemPrompt = "Answer the user's question clearly and return JSON only when explicitly requested.",
  temperature = 0
}) {
  const resolvedApiKey = resolveApiKey({ apiKey });
  if (!resolvedApiKey) {
    throw new Error("Missing Perplexity API key. Set PERPLEXITY_API_KEY or pass apiKey.");
  }

  if (!String(question || "").trim()) {
    throw new Error("Missing question.");
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolvedApiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: question
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Perplexity request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const message = payload?.choices?.[0]?.message;
  const parsedContent = parseMessageContent(message?.content);

  return {
    model: payload?.model || model,
    question,
    answer: parsedContent.text,
    parsedJson: parsedContent.json,
    citations: Array.isArray(message?.citations) ? message.citations : [],
    usage: payload?.usage || null,
    raw: payload
  };
}
