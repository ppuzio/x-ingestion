import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  RELEVANCE_TRIAGE_VERSION,
  oldestFirst,
  triageRelevance,
  type RelevanceAssessment,
  type RelevanceStatus,
} from "../llm/triage-relevance.ts";
import type { SavedPost } from "../model.ts";
import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";
import {
  loadCachedAssessment,
  hydrateCachedSourceContext,
  modelDirectory,
  parseArguments,
  parseLimitArgument,
  reportTitle,
  requiredEnvironmentVariable,
  runMain,
  saveJson,
} from "./util.ts";

const BATCH_SIZE = 20;

function report(
  posts: SavedPost[],
  assessments: RelevanceAssessment[],
  model: string,
  totalPosts: number,
): string {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const headings: Record<RelevanceStatus, string> = {
    time_sensitive: "Needs web verification",
    non_knowledge: "Not knowledge content",
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
    "non_knowledge",
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
        `- [${reportTitle(post).replaceAll("]", "\\]")}](${post.url}) — ${assessment.reason}`,
        ...(assessment.webQuery ? [`  - Suggested query: ${assessment.webQuery}`] : []),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const limit = parseLimitArgument(process.argv);
  const postIds = parseArguments(process.argv, "post");
  const refresh = process.argv.includes("--refresh");

  const allPosts = oldestFirst(await loadSnapshots(await latestSnapshots()));
  await hydrateCachedSourceContext(allPosts);
  const posts = postIds.length
    ? allPosts.filter(({ id }) => postIds.includes(id))
    : allPosts.slice(0, limit);
  if (postIds.length && posts.length !== new Set(postIds).size) {
    throw new Error("One or more requested saved posts were not found");
  }
  const apiKey = requiredEnvironmentVariable("OPENROUTER_KEY");
  const model =
    process.env.OPENROUTER_TRIAGE_MODEL?.trim() ||
    process.env.OPENROUTER_SYNTHESIS_MODEL?.trim() ||
    "qwen/qwen3-vl-32b-instruct";
  const cacheRoot = resolve(
    "data/enrichment/relevance-triage",
    RELEVANCE_TRIAGE_VERSION,
    modelDirectory(model),
  );
  const assessments = new Map<string, RelevanceAssessment>();
  const uncached: SavedPost[] = [];
  const currentDate = new Date().toISOString().slice(0, 10);
  for (const post of posts) {
    if (refresh) {
      uncached.push(post);
      continue;
    }
    const cached = await loadCachedAssessment(cacheRoot, post, currentDate);
    if (!cached) {
      uncached.push(post);
      continue;
    }
    assessments.set(post.id, cached);
  }

  for (let index = 0; index < uncached.length; index += BATCH_SIZE) {
    const batch = uncached.slice(index, index + BATCH_SIZE);
    const result = await triageRelevance(
      apiKey,
      model,
      batch,
      currentDate,
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
  const reportPath = resolve("data/obsidian-preview/_Relevance_Triage.md");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report(posts, ordered, model, allPosts.length), "utf8");
  console.log(
    `Triaged ${ordered.length} posts (${uncached.length} new) and wrote ${reportPath}`,
  );
}

runMain(main);
