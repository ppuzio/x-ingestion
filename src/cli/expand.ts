import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";
import {
  externalUrlsForPost,
  expandExternalLinks,
  expandThreadsAndContexts,
  shouldExpandThread,
} from "../x/expand.ts";
import { parseLimitArgument, requiredEnvironmentVariable, runMain } from "./util.ts";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const limit = parseLimitArgument(process.argv);
  const snapshots = await latestSnapshots();
  const initialPosts = (await loadSnapshots(snapshots)).slice(0, limit);
  if (dryRun) {
    const contextCandidates = initialPosts.reduce(
      (count, post) => count + post.relationships.filter(
        ({ type, text }) => type === "replied_to" && !text,
      ).length,
      0,
    );
    const threadCandidates = initialPosts.filter(shouldExpandThread).length;
    const linkCandidates = initialPosts.reduce(
      (count, post) => count + externalUrlsForPost(post).length,
      0,
    );
    console.log(
      `Dry run for ${initialPosts.length} posts: ${threadCandidates} thread candidate(s), ` +
        `${contextCandidates} context post(s), ${linkCandidates} external link candidate(s)`,
    );
    return;
  }
  const bearerToken =
    process.env.X_ARCHIVE_BEARER_TOKEN?.trim() ||
    requiredEnvironmentVariable("X_BEARER_TOKEN");
  const context = await expandThreadsAndContexts(initialPosts, bearerToken);

  // Thread/context captures change the normalized relationships and may expose
  // new external links, so reload before the link pass.
  const posts = (await loadSnapshots(await latestSnapshots())).slice(0, limit);
  const links = await expandExternalLinks(posts);
  const failures = [...context.failures, ...links.failures];
  console.log(
    `Expanded ${posts.length} posts: ${context.threadsCaptured} thread(s), ` +
      `${context.contextsCaptured} context post(s), ${links.linksCaptured} link page(s) ` +
      `(${links.linksSkipped} skipped)`,
  );
  if (failures.length) {
    console.warn(`Expansion had ${failures.length} failure(s):`);
    failures.forEach((failure) => console.warn(`- ${failure}`));
  }
}

runMain(main);
