import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { object, string, strings } from "../json.ts";
import { requestStructuredJson } from "../llm/openrouter.ts";
import { normalizeTopicCase } from "../obsidian/render.ts";
import {
  exists,
  modelDirectory,
  requiredEnvironmentVariable,
  runMain,
  saveJson,
} from "./util.ts";

const AUDIT_VERSION = "v2";
const categories = ["topic", "concept", "technology", "person"] as const;
type Category = (typeof categories)[number];
type Action = "merge" | "rename" | "do_not_link";

interface InventoryItem {
  category: Category;
  name: string;
  count: number;
  postIds: string[];
}

interface Proposal {
  category: Category;
  action: Action;
  canonical: string | null;
  members: string[];
  rationale: string;
}

async function latestNormalized(): Promise<string> {
  const directory = resolve("data/normalized");
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".normalized.json"),
  );
  files.sort((a, b) => {
    const timestamp = (name: string): string =>
      name.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/)?.[0] ?? "";
    return timestamp(a).localeCompare(timestamp(b));
  });
  const latest = files.at(-1);
  if (!latest) throw new Error("No canonical snapshots found in data/normalized");
  return resolve(directory, latest);
}

function collectInventory(input: unknown): {
  items: InventoryItem[];
  synthesisVersion: string;
} {
  if (!Array.isArray(input)) throw new Error("Canonical snapshot must be an array");
  const fields: Record<Category, string> = {
    topic: "topics",
    concept: "concepts",
    technology: "technologies",
    person: "people",
  };
  const entries = new Map<string, InventoryItem>();
  const versions = new Set<string>();

  for (const rawPost of input) {
    const post = object(rawPost);
    const id = string(post?.id);
    const enrichment = object(post?.enrichment);
    const promptVersion = string(enrichment?.promptVersion);
    if (!enrichment || !promptVersion) {
      throw new Error(
        `Post ${id ?? "(unknown id)"} has no synthesis; run npm run preview:enrich before auditing`,
      );
    }
    if (!id) throw new Error("Every canonical post must have an id");
    versions.add(promptVersion);
    for (const category of categories) {
      const names = strings(enrichment[fields[category]]);
      if (!names) throw new Error(`Invalid ${fields[category]} for post ${id}`);
      const normalizedNames = names
        .map((value) => value.trim())
        .filter(Boolean)
        .map((name) => category === "topic" ? normalizeTopicCase(name) : name);
      for (const name of new Set(normalizedNames)) {
        const key = `${category}\0${name}`;
        const entry = entries.get(key) ?? { category, name, count: 0, postIds: [] };
        entry.count += 1;
        entry.postIds.push(id);
        entries.set(key, entry);
      }
    }
  }

  if (versions.size !== 1) {
    throw new Error("Concept audit requires one synthesis prompt version");
  }
  return {
    items: [...entries.values()].sort(
      (a, b) =>
        categories.indexOf(a.category) - categories.indexOf(b.category) ||
        a.name.localeCompare(b.name),
    ),
    synthesisVersion: [...versions][0]!,
  };
}

function parseProposals(value: unknown, inventory: InventoryItem[]): Proposal[] {
  const rows = object(value)?.proposals;
  if (!Array.isArray(rows)) throw new Error("Concept audit output has no proposals array");
  const available = new Set(inventory.map((item) => `${item.category}\0${item.name}`));
  const used = new Set<string>();
  const proposals: Proposal[] = [];

  rows.forEach((raw, index) => {
    const row = object(raw);
    const category = string(row?.category);
    const action = string(row?.action);
    const canonical = row?.canonical;
    const members = strings(row?.members);
    const rationale = string(row?.rationale);
    if (
      !categories.includes(category as Category) ||
      !["merge", "rename", "do_not_link"].includes(action ?? "") ||
      !(typeof canonical === "string" || canonical === null) ||
      !members?.length ||
      !rationale?.trim()
    ) {
      console.warn(`Rejected invalid concept proposal ${index}`);
      return;
    }
    if (action === "merge" && members.length < 2) {
      console.warn(`Rejected one-member merge proposal ${index}`);
      return;
    }
    if (new Set(members).size !== members.length) {
      console.warn(`Rejected proposal ${index} with duplicate members`);
      return;
    }
    if (action === "rename" && members.length !== 1) {
      console.warn(`Rejected multi-member rename proposal ${index}`);
      return;
    }
    if (action === "rename" && canonical === members[0]) {
      console.warn(`Rejected no-op rename proposal ${index}`);
      return;
    }
    if (action === "do_not_link" ? canonical !== null : !canonical?.trim()) {
      console.warn(`Rejected proposal ${index} with an invalid canonical value`);
      return;
    }
    const matchingCategories = categories.filter((candidate) =>
      members.every((member) => available.has(`${candidate}\0${member}`)),
    );
    const resolvedCategory = available.has(`${category}\0${members[0]}`)
      ? (category as Category)
      : matchingCategories.length === 1
        ? matchingCategories[0]!
        : undefined;
    if (!resolvedCategory || !members.every((member) => available.has(`${resolvedCategory}\0${member}`))) {
      console.warn(`Rejected proposal ${index} with mixed or unknown inventory members`);
      return;
    }
    const keys = members.map((member) => `${resolvedCategory}\0${member}`);
    if (keys.some((key) => used.has(key))) {
      console.warn(`Rejected proposal ${index} because a member was already proposed`);
      return;
    }
    for (const member of members) {
      used.add(`${resolvedCategory}\0${member}`);
    }
    proposals.push({
      category: resolvedCategory,
      action: action as Action,
      canonical,
      members,
      rationale,
    });
  });
  return proposals;
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function renderSection(proposals: Proposal[], action: Action, title: string): string[] {
  const matches = proposals.filter((proposal) => proposal.action === action);
  const lines = ["", `## ${title}`, ""];
  if (!matches.length) return [...lines, "- None"];
  for (const proposal of matches) {
    lines.push(
      `### ${proposal.canonical ?? "Do not create nodes"}`,
      "",
      `- Category: ${proposal.category}`,
      `- Current: ${proposal.members.map(code).join(", ")}`,
      `- Reason: ${proposal.rationale}`,
      "",
    );
  }
  return lines;
}

function renderReport(
  snapshot: string,
  model: string,
  synthesisVersion: string,
  inventory: InventoryItem[],
  proposals: Proposal[],
): string {
  const lines = [
    "# Concept audit proposal",
    "",
    "This report is read-only. No notes or wikilinks have been changed.",
    "Every proposal requires human approval. Reject merges that describe broader, narrower, or merely related ideas rather than true synonyms.",
    "",
    `- Canonical snapshot: ${code(snapshot)}`,
    `- Synthesis prompt: ${code(synthesisVersion)}`,
    `- Audit prompt: ${code(AUDIT_VERSION)}`,
    `- Audit model: ${code(model)}`,
    `- Candidate names: ${inventory.length}`,
    `- Proposed changes: ${proposals.length}`,
    ...renderSection(proposals, "merge", "Proposed merges"),
    ...renderSection(proposals, "rename", "Proposed renames"),
    ...renderSection(proposals, "do_not_link", "Proposed plain text (no wikilink)"),
    "",
    "## Full inventory",
  ];
  const headings: Record<Category, string> = {
    topic: "Topics",
    concept: "Concepts",
    technology: "Technologies",
    person: "People",
  };
  for (const category of categories) {
    const items = inventory.filter((item) => item.category === category);
    lines.push("", `### ${headings[category]} (${items.length})`, "");
    lines.push(
      ...items.map(
        (item) =>
          `- ${code(item.name)} — ${item.count} post${item.count === 1 ? "" : "s"}: ${item.postIds.join(", ")}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const snapshot = resolve(process.argv[2] ?? (await latestNormalized()));
  const { items, synthesisVersion } = collectInventory(
    JSON.parse(await readFile(snapshot, "utf8")) as unknown,
  );
  const apiKey = requiredEnvironmentVariable("OPENROUTER_KEY");
  const model =
    process.env.OPENROUTER_SYNTHESIS_MODEL?.trim() || "qwen/qwen3-vl-32b-instruct";
  const cachePath = resolve(
    "data/enrichment/concept-audit",
    AUDIT_VERSION,
    synthesisVersion,
    modelDirectory(model),
    basename(snapshot),
  );

  let proposals: Proposal[];
  if (await exists(cachePath)) {
    proposals = parseProposals(JSON.parse(await readFile(cachePath, "utf8")), items);
  } else {
    const result = await requestStructuredJson(
      apiKey,
      model,
      [
        {
          type: "text",
          text: [
            "Audit this proposed Obsidian vocabulary. Return only changes worth human review; omitted entries remain unchanged.",
            "Use merge only for true synonyms, rename for a clearer durable canonical name, and do_not_link for overly specific, ephemeral, sentence-like, or low-value graph nodes.",
            "Related ideas are not necessarily synonyms. Be conservative with proper names, technologies, and people. Never merge across categories.",
            "Every member must exactly match a name in the supplied inventory. This is a proposal only; do not claim changes were applied.",
            "Return no more than the 30 highest-confidence proposed changes.",
            JSON.stringify(items),
          ].join("\n\n"),
        },
      ],
      "concept_audit",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          proposals: {
            type: "array",
            maxItems: 30,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                category: { type: "string", enum: categories },
                action: {
                  type: "string",
                  enum: ["merge", "rename", "do_not_link"],
                },
                canonical: { type: ["string", "null"] },
                members: { type: "array", items: { type: "string" } },
                rationale: { type: "string" },
              },
              required: ["category", "action", "canonical", "members", "rationale"],
            },
          },
        },
        required: ["proposals"],
      },
    );
    proposals = parseProposals(result.parsed, items);
    await saveJson(cachePath, { proposals, rawResponse: result.rawResponse });
  }

  const reportPath = resolve("data/obsidian-preview/_Concept_Audit.md");
  await writeFile(
    reportPath,
    renderReport(snapshot, model, synthesisVersion, items, proposals),
    "utf8",
  );
  console.log(`Wrote ${proposals.length} proposed changes to ${reportPath}`);
}

runMain(main);
