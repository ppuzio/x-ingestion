import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  RELEVANCE_TRIAGE_VERSION,
  parseRelevanceAssessments,
  triageRelevance,
  type RelevanceAssessment,
  type RelevanceStatus,
} from "../llm/triage-relevance.ts";
import type { SavedPost } from "../model.ts";
import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";

const BATCH_SIZE = 20;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function titleFor(post: SavedPost): string {
  const article = post.fragments.find((fragment) => fragment.kind === "article");
  if (article) return article.title;
  const text = post.fragments.find((fragment) => fragment.kind === "text");
  return (text?.text.replace(/https?:\/\/\S+/g, "").trim() || post.url)
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function report(
  posts: SavedPost[],
  assessments: RelevanceAssessment[],
  model: string,
  totalPosts: number,
): string {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const headings: Record<RelevanceStatus, string> = {
    time_sensitive: "Needs web verification",
    low_signal: "Low signal",
    unclear: "Unclear without more context",
    durable: "Durable",
  };
  const lines = [
    "# Relevance triage",
    "",
    "This is a cached, no-web triage. It never deletes or hides a post.",
    "Only `time_sensitive` items are candidates for later evidence-backed web verification.",
    "",
    `- Assessed: ${assessments.length} of ${totalPosts} posts`,
    `- Model: \`${model}\``,
    `- Prompt: \`${RELEVANCE_TRIAGE_VERSION}\``,
  ];
  for (const status of [
    "time_sensitive",
    "low_signal",
    "unclear",
    "durable",
  ] satisfies RelevanceStatus[]) {
    const matches = assessments.filter((item) => item.status === status);
    lines.push("", `## ${headings[status]} (${matches.length})`, "");
    if (!matches.length) {
      lines.push("- None");
      continue;
    }
    for (const assessment of matches) {
      const post = byId.get(assessment.postId)!;
      lines.push(
        `- [${titleFor(post).replaceAll("]", "\\]")}](${post.url}) — ${assessment.reason}`,
        ...(assessment.webQuery ? [`  - Suggested query: ${assessment.webQuery}`] : []),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
  const limit = limitArgument
    ? Number.parseInt(limitArgument.slice("--limit=".length), 10)
    : Number.POSITIVE_INFINITY;
  if (!(limit > 0)) throw new Error("--limit must be a positive integer");

  const allPosts = await loadSnapshots(await latestSnapshots());
  const posts = allPosts.slice(0, limit);
  const apiKey = process.env.OPENROUTER_KEY?.trim();
  if (!apiKey) throw new Error("Missing OPENROUTER_KEY");
  const model =
    process.env.OPENROUTER_TRIAGE_MODEL?.trim() ||
    process.env.OPENROUTER_SYNTHESIS_MODEL?.trim() ||
    "qwen/qwen3-vl-32b-instruct";
  const modelDirectory = model.replace(/[^a-z0-9._-]+/gi, "_");
  const cacheRoot = resolve(
    "data/enrichment/relevance-triage",
    RELEVANCE_TRIAGE_VERSION,
    modelDirectory,
  );
  const assessments = new Map<string, RelevanceAssessment>();
  const uncached: SavedPost[] = [];
  for (const post of posts) {
    const cachePath = resolve(cacheRoot, `${post.id}.json`);
    if (!(await exists(cachePath))) {
      uncached.push(post);
      continue;
    }
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
      assessment?: unknown;
    };
    const assessment = parseRelevanceAssessments(
      { assessments: [cached.assessment] },
      [post.id],
    )[0]!;
    assessments.set(post.id, assessment);
  }

  for (let index = 0; index < uncached.length; index += BATCH_SIZE) {
    const batch = uncached.slice(index, index + BATCH_SIZE);
    const result = await triageRelevance(
      apiKey,
      model,
      batch,
      new Date().toISOString().slice(0, 10),
    );
    for (const assessment of result.assessments) {
      assessments.set(assessment.postId, assessment);
      await saveJson(resolve(cacheRoot, `${assessment.postId}.json`), {
        assessment,
        model,
        promptVersion: RELEVANCE_TRIAGE_VERSION,
        createdAt: new Date().toISOString(),
      });
    }
    await saveJson(
      resolve(cacheRoot, "raw", `batch-${batch[0]!.id}.json`),
      result.rawResponse,
    );
  }

  const ordered = posts.map((post) => assessments.get(post.id)!);
  const reportPath = resolve("data/obsidian-preview/_Relevance Triage.md");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report(posts, ordered, model, allPosts.length), "utf8");
  console.log(
    `Triaged ${ordered.length} posts (${uncached.length} new) and wrote ${reportPath}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
