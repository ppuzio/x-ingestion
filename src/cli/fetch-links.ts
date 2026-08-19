import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { LinkFragment, SavedPost } from "../model.ts";
import { fetchWebPage } from "../web/page.ts";
import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";
import { parseArgument, runMain } from "./util.ts";

const MAX_LINKS_PER_POST = 5;

function externalUrls(post: SavedPost): string[] {
  const links: LinkFragment[] = [
    ...post.fragments.filter(
      (fragment): fragment is LinkFragment => fragment.kind === "link",
    ),
    ...post.relationships.flatMap(({ links: relationshipLinks }) =>
      relationshipLinks ?? [],
    ),
  ];
  return [...new Set(links.flatMap(({ url }) => {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      return ["x.com", "twitter.com", "t.co", "twimg.com"].some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      )
        ? []
        : [parsed.toString()];
    } catch {
      return [];
    }
  }))];
}

async function capture(post: SavedPost, sourceUrl: string): Promise<string> {
  const page = await fetchWebPage(sourceUrl);
  const capturedAt = new Date().toISOString();
  const timestamp = capturedAt.replaceAll(":", "-").replaceAll(".", "-");
  const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 12);
  const relativeRoot = `data/raw/web/${post.id}`;
  const basename = `page-${hash}-${timestamp}`;
  const rawPath = `${relativeRoot}/${basename}.html`;
  const metadataPath = `${relativeRoot}/${basename}.json`;
  await mkdir(resolve(relativeRoot), { recursive: true });
  await writeFile(resolve(rawPath), page.bytes, { flag: "wx" });
  await writeFile(
    resolve(metadataPath),
    `${JSON.stringify({
      sourceUrl: page.sourceUrl,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      title: page.title,
      ...(page.byline ? { byline: page.byline } : {}),
      ...(page.excerpt ? { excerpt: page.excerpt } : {}),
      text: page.text,
      capturedAt,
      rawPath,
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return metadataPath;
}

async function main(): Promise<void> {
  const postId = parseArgument(process.argv, "post");
  if (!postId) throw new Error("Pass one saved post as --post=<X post ID>");
  const post = (await loadSnapshots(await latestSnapshots())).find(
    ({ id }) => id === postId,
  );
  if (!post) throw new Error(`Saved post ${postId} was not found`);
  const urls = externalUrls(post);
  if (!urls.length) throw new Error(`Post ${postId} has no captured external links`);
  if (urls.length > MAX_LINKS_PER_POST) {
    throw new Error(
      `Post ${postId} has ${urls.length} external links; refusing to fetch more than ${MAX_LINKS_PER_POST}`,
    );
  }

  const failures: string[] = [];
  for (const url of urls) {
    try {
      console.log(`Saved ${url} to ${await capture(post, url)}`);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (failures.length) throw new Error(`External link capture failed:\n${failures.join("\n")}`);
}

runMain(main);
