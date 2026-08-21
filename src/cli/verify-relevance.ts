import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { UrlCitation } from "../llm/openrouter.ts";
import {
  RELEVANCE_TRIAGE_VERSION,
  oldestFirst,
  type RelevanceAssessment,
} from "../llm/triage-relevance.ts";
import {
  RELEVANCE_EVIDENCE_VERSION,
  RELEVANCE_VERIFICATION_VERSION,
  classifyRelevance,
  finalRelevanceStatus,
  parseRelevanceVerification,
  protectVerification,
  requestedVerification,
  researchRelevance,
  requireVerificationEvidence,
  type RelevanceVerification,
  type FinalRelevanceStatus,
  type VerificationVerdict,
} from "../llm/verify-relevance.ts";
import type { SavedPost } from "../model.ts";
import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";
import {
  datedDirectories,
  exists,
  hydrateCachedSourceContext,
  loadCachedAssessment,
  modelDirectory,
  parseArgument,
  parseLimitArgument,
  reportTitle,
  requiredEnvironmentVariable,
  runMain,
  saveJson,
} from "./util.ts";

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

async function latestDatedCachePath(
  versionRoot: string,
  postId: string,
): Promise<string | undefined> {
  for (const date of await datedDirectories(versionRoot)) {
    const path = resolve(versionRoot, date, `${postId}.json`);
    if (await exists(path)) return path;
  }
  return undefined;
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
        `- [${reportTitle(post).replaceAll("]", "\\]")}](${post.url}) — ${verification.reason}`,
        `  - Current guidance: ${verification.currentGuidance}`,
        ...citations.filter(
          ({ url }) => verification.evidenceUrls.includes(url),
        ).map(
          ({ url, title }) => `  - Source: [${(title || url).replaceAll("]", "\\]")}](${url})`,
        ),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function auditReport(
  rows: Array<{
    post: SavedPost;
    assessment: RelevanceAssessment;
    verification?: RelevanceVerification;
    citations: UrlCitation[];
  }>,
  model: string,
  totalPosts: number,
  date: string,
): string {
  const headings: Record<FinalRelevanceStatus, string> = {
    superseded: "Superseded",
    partly_current: "Partly current",
    current: "Current",
    opinion: "Opinion, not a freshness claim",
    durable: "Durable",
    unclear: "Unclear after verification",
    needs_context: "Needs context",
    non_knowledge: "Not knowledge content",
    needs_verification: "Needs web verification",
  };
  const statuses = [
    "superseded",
    "partly_current",
    "current",
    "opinion",
    "durable",
    "unclear",
    "needs_context",
    "non_knowledge",
    "needs_verification",
  ] satisfies FinalRelevanceStatus[];
  const lines = [
    "# Relevance audit",
    "",
    "This is the authoritative relevance view. Triage only routes potentially time-sensitive posts; an evidence-backed verification verdict replaces that preliminary label.",
    "Nothing is deleted or hidden.",
    "",
    `- Assessed: ${rows.length} of ${totalPosts} posts`,
    `- Web-verified: ${rows.filter(({ verification }) => verification).length}`,
    `- Checked: ${date}`,
    `- Verification model: \`${model}\``,
    `- Triage prompt: \`${RELEVANCE_TRIAGE_VERSION}\``,
    `- Verification prompt: \`${RELEVANCE_VERIFICATION_VERSION}\``,
  ];
  for (const status of statuses) {
    const matches = rows.filter(
      ({ assessment, verification }) =>
        finalRelevanceStatus(assessment, verification) === status,
    );
    lines.push("", `## ${headings[status]} (${matches.length})`, "");
    if (!matches.length) {
      lines.push("- None");
      continue;
    }
    for (const { post, assessment, verification, citations } of matches) {
      lines.push(
        `- [${reportTitle(post).replaceAll("]", "\\]")}](${post.url}) — ${verification?.reason ?? assessment.reason}`,
        ...(verification
          ? [`  - Current guidance: ${verification.currentGuidance}`]
          : []),
        ...citations.filter(
          ({ url }) => verification?.evidenceUrls.includes(url),
        ).map(
          ({ url, title }) => `  - Source: [${(title || url).replaceAll("]", "\\]")}](${url})`,
        ),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const postId = parseArgument(process.argv, "post");
  const refreshEvidence = process.argv.includes("--refresh-evidence");
  const reportOnly = process.argv.includes("--report-only");
  const limit = parseLimitArgument(process.argv);

  const posts = oldestFirst(await loadSnapshots(await latestSnapshots()));
  await hydrateCachedSourceContext(posts);
  const apiKey = requiredEnvironmentVariable("OPENROUTER_KEY");
  const triageModel =
    process.env.OPENROUTER_TRIAGE_MODEL?.trim() ||
    process.env.OPENROUTER_SYNTHESIS_MODEL?.trim() ||
    "qwen/qwen3-vl-32b-instruct";
  const model =
    process.env.OPENROUTER_VERIFICATION_MODEL?.trim() || "openai/gpt-5.6-luna";
  const searchModel =
    process.env.OPENROUTER_SEARCH_MODEL?.trim() || model;
  const triageRoot = resolve(
    "data/enrichment/relevance-triage",
    RELEVANCE_TRIAGE_VERSION,
    modelDirectory(triageModel),
  );
  const date = new Date().toISOString().slice(0, 10);
  const triaged: Array<{ post: SavedPost; assessment: RelevanceAssessment }> = [];
  for (const post of posts) {
    const assessment = await loadCachedAssessment(triageRoot, post, date);
    if (assessment) triaged.push({ post, assessment });
  }
  const eligible = triaged.filter(
    ({ assessment }) => assessment.status === "time_sensitive",
  );
  if (!eligible.length && !postId && !reportOnly) {
    throw new Error("No time-sensitive triage results found; run npm run triage:relevance first");
  }
  const selected = postId
    ? triaged.filter(({ post }) => post.id === postId)
    : reportOnly
      ? triaged.slice(0, limit)
    : eligible.slice(0, limit);
  if (!selected.length) {
    throw new Error(
      postId
        ? `No eligible triage result found for ${postId}`
        : "No triage results found; run npm run triage:relevance first",
    );
  }

  const evidenceVersionRoot = resolve(
    "data/enrichment/relevance-evidence",
    RELEVANCE_EVIDENCE_VERSION,
  );
  const evidenceRoot = resolve(evidenceVersionRoot, date);
  const cacheVersionRoot = resolve(
    "data/enrichment/relevance-verification",
    RELEVANCE_VERIFICATION_VERSION,
    modelDirectory(model),
  );
  const cacheRoot = resolve(cacheVersionRoot, date);
  const rows = [] as Array<{
    post: SavedPost;
    verification: RelevanceVerification;
    citations: UrlCitation[];
  }>;
  let created = 0;
  let searched = 0;
  for (const { post, assessment: triageAssessment } of selected) {
    const assessment = requestedVerification(
      triageAssessment,
      `${reportTitle(post)} current status ${date.slice(0, 4)}`,
    );
    const evidencePath = resolve(evidenceRoot, `${post.id}.json`);
    let citations: UrlCitation[] = [];
    const cachedEvidencePath = !refreshEvidence
      ? await latestDatedCachePath(evidenceVersionRoot, post.id)
      : undefined;
    if (cachedEvidencePath) {
      const cached = JSON.parse(await readFile(cachedEvidencePath, "utf8")) as {
        citations?: unknown;
      };
      citations = cachedCitations(cached.citations);
    } else if (reportOnly) {
      continue;
    } else {
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
      await saveJson(evidencePath, {
        citations,
        searchModel,
        evidenceVersion: RELEVANCE_EVIDENCE_VERSION,
        createdAt: new Date().toISOString(),
      });
    }

    const path = resolve(cacheRoot, `${post.id}.json`);
    const cachedVerificationPath = !refreshEvidence
      ? await latestDatedCachePath(cacheVersionRoot, post.id)
      : undefined;
    if (cachedVerificationPath) {
      const cached = JSON.parse(await readFile(cachedVerificationPath, "utf8")) as {
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
    if (reportOnly) continue;
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
  const auditPath = resolve("data/obsidian-preview/_Relevance_Audit.md");
  await mkdir(dirname(reportPath), { recursive: true });
  const verifiedById = new Map(rows.map((row) => [row.post.id, row]));
  await Promise.all([
    writeFile(reportPath, report(rows, model, eligible.length, date), "utf8"),
    writeFile(
      auditPath,
      auditReport(
        triaged.map(({ post, assessment }) => {
          const row = verifiedById.get(post.id);
          return {
            post,
            assessment,
            ...(row?.verification ? { verification: row.verification } : {}),
            citations: row?.citations ?? [],
          };
        }),
        model,
        posts.length,
        date,
      ),
      "utf8",
    ),
  ]);
  console.log(
    `Verified ${rows.length} posts (${created} new classifications, ${searched} new searches) and wrote ${reportPath} plus ${auditPath}`,
  );
}

runMain(main);
