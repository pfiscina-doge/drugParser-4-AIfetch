import { spawnSync } from "node:child_process";

function runAgentBrowserBatch(commands) {
  const result = spawnSync("agent-browser", ["batch", "--json"], {
    input: JSON.stringify(commands),
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env }
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 3000);
    throw new Error(`agent-browser exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }

  const rows = JSON.parse(result.stdout.trim());
  const failed = rows.find((row) => !row.success);
  if (failed) {
    throw new Error(
      `agent-browser step failed: ${JSON.stringify(failed.error || failed).slice(0, 1000)}`
    );
  }

  return rows;
}

function evalResults(rows) {
  return rows
    .filter((row) => row.command?.[0] === "eval")
    .map((row) => row.result?.result ?? null);
}

function expandAllScript() {
  return `
(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const textOf = (el) => norm(el?.innerText || el?.textContent || "");

  const buttons = Array.from(document.querySelectorAll('button[type="button"][aria-controls]'));
  const targets = buttons.filter((button) => {
    const label = textOf(button);
    if (!label) return false;
    return /\\?$/.test(label) || /^do not use /i.test(label) || /^general information/i.test(label);
  });

  const clicked = [];
  for (const button of targets) {
    if (button.getAttribute("aria-expanded") === "false") {
      try {
        button.click();
        clicked.push(textOf(button));
      } catch {}
    }
  }

  return {
    ok: true,
    triggerCount: targets.length,
    clicked
  };
})();
`.trim();
}

function extractAllScript() {
  return `
(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const textOf = (el) => norm(el?.innerText || el?.textContent || "");

  const buttons = Array.from(document.querySelectorAll('button[type="button"][aria-controls]'));
  const pairs = [];

  for (const button of buttons) {
    const question = textOf(button);
    const panelId = button.getAttribute("aria-controls") || "";
    if (!question || !panelId) continue;

    const panel = document.getElementById(panelId);
    const answer = textOf(panel);
    if (!answer) continue;

    pairs.push({
      question,
      answer,
      panelId
    });
  }

  return {
    url: location.href,
    title: document.title,
    qaPairs: pairs
  };
})();
`.trim();
}

export async function loadTrumpRxQaWithAgentBrowser({ drugName, trumpRxUrl }) {
  const commands = [
    ["open", trumpRxUrl],
    ["wait", "--load", "networkidle"],
    ["wait", "2000"],
    ["eval", expandAllScript()],
    ["wait", "2000"],
    ["eval", extractAllScript()],
    ["close"]
  ];

  const rows = runAgentBrowserBatch(commands);
  const [, extracted] = evalResults(rows);

  if (!extracted || !Array.isArray(extracted.qaPairs)) {
    throw new Error(`No qaPairs extracted from TrumpRX agent-browser flow for ${drugName}`);
  }

  return extracted.qaPairs.map((pair, index) => ({
    id: `${drugName}-trumprx-${index + 1}`,
    question: String(pair.question || "").trim(),
    answer: String(pair.answer || "").trim()
  })).filter((pair) => pair.question && pair.answer);
}


function extractPdfLinkScript() {
  return `
(() => {
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const candidates = anchors.map((anchor) => ({
    href: anchor.href,
    text: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim()
  }));

  const preferred = candidates.find((item) => /view .*pdf/i.test(item.text) && /\.pdf(\?|$)/i.test(item.href))
    || candidates.find((item) => /patient information/i.test(item.text) && /\.pdf(\?|$)/i.test(item.href))
    || candidates.find((item) => /medication guide/i.test(item.text) && /\.pdf(\?|$)/i.test(item.href))
    || candidates.find((item) => /\.pdf(\?|$)/i.test(item.href));

  return {
    url: location.href,
    title: document.title,
    pdfLink: preferred ? preferred.href : null,
    linkText: preferred ? preferred.text : null
  };
})();
`.trim();
}

export async function findTrumpRxPdfLinkWithAgentBrowser({ trumpRxUrl }) {
  const commands = [
    ["open", trumpRxUrl],
    ["wait", "--load", "networkidle"],
    ["wait", "2000"],
    ["eval", extractPdfLinkScript()],
    ["close"]
  ];

  const rows = runAgentBrowserBatch(commands);
  const [extracted] = evalResults(rows);
  if (!extracted || typeof extracted !== 'object') {
    throw new Error(`No PDF link extracted from TrumpRX agent-browser flow for ${trumpRxUrl}`);
  }

  return extracted;
}
