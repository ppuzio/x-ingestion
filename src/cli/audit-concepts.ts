import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";

import { object, readJson, string, strings } from "../json.ts";
import { requestStructuredJson } from "../llm/openrouter.ts";
import {
  canonicalizeConcept,
  canonicalizeTopic,
  type ConceptVocabulary,
  vocabularyKey,
} from "../obsidian/render.ts";
import {
  exists,
  modelDirectory,
  parseArgument,
  requiredEnvironmentVariable,
  runMain,
  saveJson,
} from "./util.ts";

const AUDIT_VERSION = "v5";
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

async function loadVocabulary(): Promise<{
  vocabulary: ConceptVocabulary;
  fingerprint: string;
}> {
  const contents = await readFile(resolve("config/concepts.json"), "utf8");
  return {
    vocabulary: JSON.parse(contents) as ConceptVocabulary,
    fingerprint: createHash("sha256").update(contents).digest("hex").slice(0, 12),
  };
}

function collectInventory(input: unknown, vocabulary: ConceptVocabulary): {
  items: InventoryItem[];
  synthesisVersion: string;
  includedPostCount: number;
  pendingPostIds: string[];
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
  const pendingPostIds: string[] = [];
  let includedPostCount = 0;

  for (const rawPost of input) {
    const post = object(rawPost);
    const id = string(post?.id);
    const enrichment = object(post?.enrichment);
    if (!id) throw new Error("Every canonical post must have an id");
    if (!enrichment) {
      pendingPostIds.push(id);
      continue;
    }
    const promptVersion = string(enrichment.promptVersion);
    if (!promptVersion) throw new Error(`Post ${id} has an invalid synthesis`);
    versions.add(promptVersion);
    includedPostCount += 1;
    for (const category of categories) {
      const names = strings(enrichment[fields[category]]);
      if (!names) throw new Error(`Invalid ${fields[category]} for post ${id}`);
      const normalizedNames = names
        .map((value) => value.trim())
        .filter(Boolean)
        .map((name) => {
          if (category === "topic") {
            return canonicalizeTopic(name, vocabulary.aliases.topic);
          }
          if (category === "concept") {
            return canonicalizeConcept(name, vocabulary.aliases.concept);
          }
          return name;
        });
      const seenNames = new Set<string>();
      for (const name of normalizedNames) {
        const key = `${category}\0${vocabularyKey(name)}`;
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        const entry = entries.get(key) ?? { category, name, count: 0, postIds: [] };
        entry.count += 1;
        entry.postIds.push(id);
        entries.set(key, entry);
      }
    }
  }

  if (!includedPostCount) throw new Error("No synthesized posts available for concept audit");
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
    includedPostCount,
    pendingPostIds,
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
  includedPostCount: number,
  pendingPostIds: string[],
  category: Category | undefined,
  inventory: InventoryItem[],
  proposals: Proposal[],
): string {
  const lines = [
    "# Vocabulary audit proposal",
    "",
    "This report is read-only. No notes or wikilinks have been changed.",
    "Every proposal requires human approval. Reject merges that describe broader, narrower, or merely related ideas rather than true synonyms.",
    "",
    `- Canonical snapshot: ${code(snapshot)}`,
    `- Synthesis prompt: ${code(synthesisVersion)}`,
    `- Audit prompt: ${code(AUDIT_VERSION)}`,
    `- Audit model: ${code(model)}`,
    `- Scope: ${category ?? "all categories"}`,
    `- Posts included: ${includedPostCount}`,
    `- Posts awaiting synthesis: ${pendingPostIds.length}${pendingPostIds.length ? ` (${pendingPostIds.join(", ")})` : ""}`,
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
  for (const currentCategory of category ? [category] : categories) {
    const items = inventory.filter((item) => item.category === currentCategory);
    lines.push("", `### ${headings[currentCategory]} (${items.length})`, "");
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
  const arguments_ = process.argv.slice(2);
  const allowPending = arguments_.includes("--allow-pending");
  const requestedSnapshot = arguments_.find((argument) => !argument.startsWith("--"));
  const requestedCategory = parseArgument(arguments_, "category");
  if (requestedCategory && !categories.includes(requestedCategory as Category)) {
    throw new Error(`--category must be one of: ${categories.join(", ")}`);
  }
  const category = requestedCategory as Category | undefined;
  const snapshot = resolve(requestedSnapshot ?? (await latestNormalized()));
  const { vocabulary, fingerprint: vocabularyFingerprint } = await loadVocabulary();
  const collected = collectInventory(
    await readJson(snapshot),
    vocabulary,
  );
  const { synthesisVersion, includedPostCount, pendingPostIds } = collected;
  const items = category
    ? collected.items.filter((item) => item.category === category)
    : collected.items;
  if (!items.length) throw new Error(`No ${category ?? "vocabulary"} entries available for audit`);
  if (pendingPostIds.length && !allowPending) {
    throw new Error(
      `Post ${pendingPostIds[0]} has no synthesis; run npm run preview:enrich before auditing, or use --allow-pending to exclude ${pendingPostIds.length} pending post${pendingPostIds.length === 1 ? "" : "s"}`,
    );
  }
  const apiKey = requiredEnvironmentVariable("OPENROUTER_KEY");
  const model =
    process.env.OPENROUTER_VOCABULARY_MODEL?.trim() ||
    process.env.OPENROUTER_QUERY_MODEL?.trim() ||
    "openai/gpt-5.6-luna";
  const cachePath = resolve(
    "data/enrichment/concept-audit",
    AUDIT_VERSION,
    synthesisVersion,
    modelDirectory(model),
    category ?? "all",
    vocabularyFingerprint,
    basename(snapshot),
  );

  let proposals: Proposal[];
  if (await exists(cachePath)) {
    proposals = parseProposals(await readJson(cachePath), items);
  } else {
    const result = await requestStructuredJson(
      apiKey,
      model,
      [
        {
          type: "text",
          text: [
            "Audit this proposed Obsidian vocabulary. Return only changes worth human review; omitted entries remain unchanged.",
            "Use merge only when every member is genuinely interchangeable with the canonical name: case, punctuation, hyphen, acronym, singular/plural, or established synonym variants are acceptable.",
            "Never merge a parent category with a subtype, task, tool, implementation, feature, discipline, or merely related topic. Sharing words is not evidence of synonymy; preserve useful specificity rather than flattening the vocabulary.",
            "Use rename for a clearer durable canonical name, and do_not_link only for overly specific, ephemeral, sentence-like, or low-value graph nodes. Be conservative with proper names, technologies, and people. Never merge across categories.",
            "Every member must exactly match a name in the supplied inventory. This is a proposal only; do not claim changes were applied.",
            "Return no more than the 30 highest-confidence proposed changes.",
            JSON.stringify(items.map(({ category, name, count }) => ({ category, name, count }))),
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
      { maxTokens: 8_000, reasoningEffort: "medium" },
    );
    proposals = parseProposals(result.parsed, items);
    await saveJson(cachePath, { proposals, rawResponse: result.rawResponse });
  }

  const reportPath = resolve("data/obsidian-preview/_Concept_Audit.md");
  await writeFile(
    reportPath,
    renderReport(
      snapshot,
      model,
      synthesisVersion,
      includedPostCount,
      pendingPostIds,
      category,
      items,
      proposals,
    ),
    "utf8",
  );
  console.log(`Wrote ${proposals.length} proposed changes to ${reportPath}`);
}

runMain(main);
