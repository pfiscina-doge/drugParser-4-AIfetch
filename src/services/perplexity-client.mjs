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

function trimForError(value, maxLength = 400) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

function buildHttpErrorMessage({ status, statusText, baseUrl, details }) {
  const context = [];

  if (status === 401) {
    context.push("authentication failed; the API key is missing, invalid, or expired");
  } else if (status === 403) {
    context.push("authorization failed; the API key does not have access");
  } else if (status === 404) {
    context.push("the API endpoint was not found; check the base URL");
  } else if (status === 429) {
    context.push("rate limited by Perplexity");
  } else if (status >= 500) {
    context.push("Perplexity returned a server error");
  }

  const pieces = [
    `Perplexity request failed with HTTP ${status}${statusText ? ` ${statusText}` : ""}.`,
    `URL: ${baseUrl.replace(/\/$/, "")}/chat/completions`
  ];

  if (context.length > 0) {
    pieces.push(`Cause: ${context.join("; ")}.`);
  }

  if (details) {
    pieces.push(`Response: ${details}`);
  }

  return pieces.join(" ");
}

function buildNetworkErrorMessage({ error, baseUrl }) {
  const causeCode = error?.cause?.code ? ` (${error.cause.code})` : "";
  const causeMessage = error?.cause?.message || error?.message || "Unknown network error";

  return [
    "Perplexity request could not reach the API.",
    `URL: ${baseUrl.replace(/\/$/, "")}/chat/completions.`,
    `Cause: ${causeMessage}${causeCode}.`,
    "This usually means DNS, network connectivity, TLS, firewall, or an incorrect base URL issue."
  ].join(" ");
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

  let response;

  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
  } catch (error) {
    throw new Error(buildNetworkErrorMessage({ error, baseUrl }), { cause: error });
  }

  if (!response.ok) {
    const responseText = trimForError(await response.text());
    throw new Error(
      buildHttpErrorMessage({
        status: response.status,
        statusText: response.statusText,
        baseUrl,
        details: responseText
      })
    );
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
