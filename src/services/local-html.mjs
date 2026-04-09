import { access } from "node:fs/promises";
import path from "node:path";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function findLocalHtmlRecord({ drugName, aliases = {}, sourceHtmlDir }) {
  if (!sourceHtmlDir) {
    return null;
  }

  const candidates = [drugName, ...(aliases[drugName] || [])]
    .map(slugify)
    .filter(Boolean);

  for (const candidate of candidates) {
    const htmlPath = path.join(sourceHtmlDir, `${candidate}.html`);
    if (await fileExists(htmlPath)) {
      return htmlPath;
    }
  }

  return null;
}
