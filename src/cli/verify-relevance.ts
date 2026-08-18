import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { UrlCitation } from "../llm/openrouter.ts";
import {
  RELEVANCE_TRIAGE_VERSION,
  oldestFirst,
  parseRelevanceAssessments,
  type RelevanceAssessment,
} from "../llm/triage-relevance.ts";
import {
  RELEVANCE_EVIDENCE_VERSION,
  RELEVANCE_VERIFICATION_VERSION,
  classifyRelevance,
  parseRelevanceVerification,
  protectVerification,
  researchRelevance,
  requireVerificationEvidence,
  type RelevanceVerification,
  type VerificationVerdict,
} from "../llm/verify-relevance.ts";
import type { SavedPost } from "../model.ts";
import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";

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

function modelDirectory(model: string): string {
  return model.replace(/[^a-z0-9._-]+/gi, "_");
}

function titleFor(post: SavedPost): string {
  const article = post.fragments.find((fragment) => fragment.kind === "article");
  const text = post.fragments.find((fragment) => fragment.kind === "text");
  return (article?.title || text?.text || post.url)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function cachedCitations(value: unknown): UrlCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { url, title, content } = item as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return [];
    return [{
      url,
      ...(typeof title === "string" && title.trim() ? { title } : {}),
      ...(typeof content === "string" && content.trim() ? { content } : {}),
    }];
  });
}

function report(
  rows: Array<{
    post: SavedPost;
    verification: RelevanceVerification;
    citations: UrlCitation[];
  }>,
  model: string,
  eligibleCount: number,
  date: string,
): string {
  const headings: Record<VerificationVerdict, string> = {
    superseded: "Superseded",
    partly_current: "Partly current",
    current: "Current",
    opinion: "Opinion, not a freshness claim",
    unclear: "Unclear",
  };
  const lines = [
    "# Relevance verification",
    "",
    "Evidence-backed checks for posts flagged as time-sensitive. Nothing is deleted or hidden.",
    "",
    `- Verified: ${rows.length} of ${eligibleCount} eligible posts`,
    `- Checked: ${date}`,
    `- Model: \`${model}\``,
    `- Prompt: \`${RELEVANCE_VERIFICATION_VERSION}\``,
  ];
  for (const verdict of [
    "superseded",
    "partly_current",
    "current",
    "opinion",
    "unclear",
  ] satisfies VerificationVerdict[]) {
    const matches = rows.filter(({ verification }) => verification.verdict === verdict);
    lines.push("", `## ${headings[verdict]} (${matches.length})`, "");
    if (!matches.length) {
      lines.push("- None");
      continue;
    }
    for (const { post, verification, citations } of matches) {
      lines.push(
        `- [${titleFor(post).replaceAll("]", "\\]")}](${post.url}) — ${verification.reason}`,
        `  - Current guidance: ${verification.currentGuidance}`,
        ...citations.filter(
          ({ url }) =>
            url.startsWith("https://") && verification.evidenceUrls.includes(url),
        ).map(
          ({ url, title }) => `  - Source: [${(title || url).replaceAll("]", "\\]")}](${url})`,
        ),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const postArgument = process.argv.find((argument) => argument.startsWith("--post="));
  const postId = postArgument?.slice("--post=".length);
  const refreshEvidence = process.argv.includes("--refresh-evidence");
  const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
  const limit = limitArgument
    ? Number.parseInt(limitArgument.slice("--limit=".length), 10)
    : Number.POSITIVE_INFINITY;
  if (!(limit > 0)) throw new Error("--limit must be a positive integer");

  const posts = oldestFirst(await loadSnapshots(await latestSnapshots()));
  const apiKey = process.env.OPENROUTER_KEY?.trim();
  if (!apiKey) throw new Error("Missing OPENROUTER_KEY");
  const triageModel =
    process.env.OPENROUTER_TRIAGE_MODEL?.trim() ||
    process.env.OPENROUTER_SYNTHESIS_MODEL?.trim() ||
    "qwen/qwen3-vl-32b-instruct";
  const model =
    process.env.OPENROUTER_VERIFICATION_MODEL?.trim() || "openai/gpt-5-mini";
  const searchModel =
    process.env.OPENROUTER_SEARCH_MODEL?.trim() || model;
  const triageRoot = resolve(
    "data/enrichment/relevance-triage",
    RELEVANCE_TRIAGE_VERSION,
    modelDirectory(triageModel),
  );
  const eligible: Array<{ post: SavedPost; assessment: RelevanceAssessment }> = [];
  for (const post of posts) {
    const path = resolve(triageRoot, `${post.id}.json`);
    if (!(await exists(path))) continue;
    const cached = JSON.parse(await readFile(path, "utf8")) as { assessment?: unknown };
    const assessment = parseRelevanceAssessments(
      { assessments: [cached.assessment] },
      [post.id],
    )[0]!;
    if (assessment.status === "time_sensitive") eligible.push({ post, assessment });
  }
  if (!eligible.length) {
    throw new Error("No time-sensitive triage results found; run npm run triage:relevance first");
  }
  const selected = postId
    ? eligible.filter(({ post }) => post.id === postId)
    : eligible.slice(0, limit);
  if (!selected.length) throw new Error(`No eligible triage result found for ${postId}`);

  const date = new Date().toISOString().slice(0, 10);
  const evidenceRoot = resolve(
    "data/enrichment/relevance-evidence",
    RELEVANCE_EVIDENCE_VERSION,
    date,
  );
  const cacheRoot = resolve(
    "data/enrichment/relevance-verification",
    RELEVANCE_VERIFICATION_VERSION,
    modelDirectory(model),
    date,
  );
  const rows = [] as Array<{
    post: SavedPost;
    verification: RelevanceVerification;
    citations: UrlCitation[];
  }>;
  let created = 0;
  let searched = 0;
  for (const { post, assessment } of selected) {
    const evidencePath = resolve(evidenceRoot, `${post.id}.json`);
    let citations: UrlCitation[] = [];
    if (!refreshEvidence && await exists(evidencePath)) {
      const cached = JSON.parse(await readFile(evidencePath, "utf8")) as {
        citations?: unknown;
      };
      citations = cachedCitations(cached.citations);
    } else {
      const legacyPath = resolve(
        "data/enrichment/relevance-verification/v2",
        modelDirectory(triageModel),
        date,
        `${post.id}.json`,
      );
      if (!refreshEvidence && await exists(legacyPath)) {
        const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as {
          citations?: unknown;
        };
        citations = cachedCitations(legacy.citations);
      }
      if (!citations.length) {
        const evidence = await researchRelevance(
          apiKey,
          searchModel,
          post,
          assessment,
          date,
        );
        citations = evidence.citations;
        await saveJson(
          resolve(evidenceRoot, "raw", `${post.id}.json`),
          evidence.rawResponse,
        );
        searched += 1;
      }
      await saveJson(evidencePath, {
        citations,
        searchModel,
        evidenceVersion: RELEVANCE_EVIDENCE_VERSION,
        createdAt: new Date().toISOString(),
      });
    }

    const path = resolve(cacheRoot, `${post.id}.json`);
    if (!refreshEvidence && await exists(path)) {
      const cached = JSON.parse(await readFile(path, "utf8")) as {
        verification?: unknown;
      };
      const verification = protectVerification(
        post,
        parseRelevanceVerification(cached.verification, post.id),
        citations,
      );
      requireVerificationEvidence(verification, citations);
      rows.push({ post, verification, citations });
      continue;
    }
    let result: Awaited<ReturnType<typeof classifyRelevance>>;
    try {
      result = await classifyRelevance(apiKey, model, post, citations, date);
    } catch (error) {
      throw new Error(
        `Post ${post.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
    await saveJson(path, {
      verification: result.verification,
      model,
      promptVersion: RELEVANCE_VERIFICATION_VERSION,
      createdAt: new Date().toISOString(),
    });
    await saveJson(resolve(cacheRoot, "raw", `${post.id}.json`), result.rawResponse);
    rows.push({ post, verification: result.verification, citations });
    created += 1;
  }

  const reportPath = resolve("data/obsidian-preview/_Relevance_Verification.md");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report(rows, model, eligible.length, date), "utf8");
  console.log(
    `Verified ${rows.length} posts (${created} new classifications, ${searched} new searches) and wrote ${reportPath}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
