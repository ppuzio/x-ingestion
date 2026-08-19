import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

import { object } from "../json.ts";
import type { WebPageFragment } from "../model.ts";
import { collapseWhitespace } from "../text.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;

export interface FetchedWebPage {
  sourceUrl: string;
  finalUrl: string;
  contentType: string;
  bytes: Buffer;
  title: string;
  byline?: string;
  excerpt?: string;
  text: string;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c <= 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    if (normalized.startsWith("::ffff:")) {
      return isPrivateAddress(normalized.slice("::ffff:".length));
    }
    const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
    return (
      normalized === "::" ||
      normalized === "::1" ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00
    );
  }
  return true;
}

export function hasUnsafeAddressSet(addresses: string[]): boolean {
  const publicAddresses = addresses.filter((address) => !isPrivateAddress(address));
  const riskyPrivateAddress = addresses.some((address) => {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
    return isPrivateAddress(address) && !/^fe[89ab][0-9a-f]:/.test(normalized);
  });
  return !publicAddresses.length || riskyPrivateAddress;
}

async function publicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Refusing unsupported external URL: ${value}`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error(`Refusing local external URL: ${value}`);
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (hasUnsafeAddressSet(addresses.map(({ address }) => address))) {
    throw new Error(`Refusing non-public external URL: ${value}`);
  }
  // ponytail: this is a local, explicit CLI fetch. If it ever becomes an
  // unattended service, pin the validated address to eliminate DNS rebinding.
  return url;
}

function decode(bytes: Buffer, contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function normalizeText(value: string): string {
  return value
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function extractReadablePage(
  bytes: Buffer,
  finalUrl: string,
  contentType = "text/html; charset=utf-8",
): Pick<FetchedWebPage, "title" | "byline" | "excerpt" | "text"> {
  const html = decode(bytes, contentType);
  const { document } = parseHTML(html);
  const heading = document.querySelector("h1")?.textContent;
  const embeddedTitle = html.match(
    /\b(?:blog_)?title\s*=\s*["']([^"']+)["']/i,
  )?.[1];
  const base = document.createElement("base");
  base.setAttribute("href", finalUrl);
  document.head?.prepend(base);
  const article = new Readability(document as never).parse();
  const text = normalizeText(article?.textContent ?? document.body?.textContent ?? "");
  if (!text) throw new Error(`Could not extract readable text from ${finalUrl}`);
  const title = collapseWhitespace(
    article?.title || document.title || heading || embeddedTitle || new URL(finalUrl).hostname,
  );
  const byline = collapseWhitespace(article?.byline ?? "");
  const excerpt = collapseWhitespace(article?.excerpt ?? "");
  return {
    title,
    ...(byline ? { byline } : {}),
    ...(excerpt ? { excerpt } : {}),
    text,
  };
}

async function readLimited(response: Response): Promise<Buffer> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
    throw new Error(`External page exceeds ${MAX_BYTES} bytes`);
  }
  if (!response.body) throw new Error("External page returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`External page exceeds ${MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

export async function fetchWebPage(sourceUrl: string): Promise<FetchedWebPage> {
  let url = await publicUrl(sourceUrl);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "x-ingestion/0.1 (personal knowledge capture)",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === MAX_REDIRECTS) {
        throw new Error(`External page exceeded ${MAX_REDIRECTS} redirects`);
      }
      url = await publicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      throw new Error(`External page failed (${response.status}) for ${url}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
      throw new Error(`Unsupported external content type ${contentType || "unknown"}`);
    }
    const bytes = await readLimited(response);
    return {
      sourceUrl,
      finalUrl: url.toString(),
      contentType,
      bytes,
      ...extractReadablePage(bytes, url.toString(), contentType),
    };
  }
  throw new Error(`External page exceeded ${MAX_REDIRECTS} redirects`);
}

export function webPageFragment(value: unknown): WebPageFragment {
  const row = object(value);
  const sourceUrl = row?.sourceUrl;
  const finalUrl = row?.finalUrl;
  const contentType = row?.contentType;
  const title = row?.title;
  const byline = row?.byline;
  const excerpt = row?.excerpt;
  const text = row?.text;
  const capturedAt = row?.capturedAt;
  const rawPath = row?.rawPath;
  if (
    typeof sourceUrl !== "string" ||
    typeof finalUrl !== "string" ||
    typeof contentType !== "string" ||
    typeof title !== "string" ||
    !(typeof byline === "string" || byline === undefined) ||
    !(typeof excerpt === "string" || excerpt === undefined) ||
    typeof text !== "string" ||
    !text.trim() ||
    typeof capturedAt !== "string" ||
    typeof rawPath !== "string"
  ) {
    throw new Error("Stored external page failed runtime validation");
  }
  return {
    kind: "web_page",
    sourceUrl,
    url: finalUrl,
    contentType,
    title,
    ...(byline ? { byline } : {}),
    ...(excerpt ? { excerpt } : {}),
    text,
    capturedAt,
    rawPath,
  };
}
