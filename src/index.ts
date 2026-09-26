import detailScript from "../dist/detail.txt";
import markdownScript from "../dist/markdown.txt";
import {
  detail,
  numberParam,
  parseQuery,
  readUpdate,
  search,
  update,
} from "./db";
import { clearSearches, recentSearches, saveSearch } from "./history";
import { favicon } from "./favicon";
import { detailPage, searchPage } from "./html";
import { HTTPError, type Env } from "./types";
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  // Preserve Origin on form POSTs without sending search URLs in Referer.
  "Referrer-Policy": "strict-origin",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers });
const html = (value: string) =>
  new Response(value, {
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
export default {
  async fetch(request, env, ctx) {
    try {
      const identity = await ctx.access?.getIdentity();
      if (
        !env.ALLOWED_EMAIL ||
        identity?.email?.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()
      )
        return json(
          { error: "Cloudflare Access authentication required" },
          403,
        );
      const url = new URL(request.url);
      const email = identity.email.toLowerCase();
      if (!["GET", "HEAD"].includes(request.method)) {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin)
          throw new HTTPError(403, "Cross-origin mutation denied");
        if (request.headers.get("Sec-Fetch-Site") === "cross-site")
          throw new HTTPError(403, "Cross-site mutation denied");
      }
      if (request.method === "GET") {
        if (
          url.pathname === "/assets/markdown.js" ||
          url.pathname === "/assets/detail.js"
        )
          return new Response(
            url.pathname === "/assets/markdown.js"
              ? markdownScript
              : detailScript,
            {
              headers: {
                ...headers,
                "Content-Type": "text/javascript; charset=utf-8",
              },
            },
          );
        if (url.pathname === "/favicon.svg")
          return new Response(favicon, {
            headers: { ...headers, "Content-Type": "image/svg+xml" },
          });
        if (url.pathname === "/api/v1/me")
          return json({ email: identity.email });
        if (url.pathname === "/api/v1/search" || url.pathname === "/") {
          const result = await search(env.DB, url);
          return url.pathname === "/"
            ? html(
                searchPage(
                  url,
                  result,
                  identity.email,
                  await recentSearches(env.DB, email),
                ),
              )
            : json(result);
        }
        const match = url.pathname.match(/^\/(api\/v1\/)?sessions\/(\d+)$/);
        if (match) {
          const id = Number(match[2]);
          if (!Number.isSafeInteger(id))
            throw new HTTPError(400, "Invalid session ID");
          const result = await detail(
            env.DB,
            id,
            numberParam(url, "after", 0, Number.MAX_SAFE_INTEGER),
          );
          return match[1]
            ? json(result)
            : html(detailPage(result, identity.email, url));
        }
      }
      if (request.method === "POST" && url.pathname === "/search") {
        const body = await request.text();
        if (body.length > 16 * 1024) throw new HTTPError(413, "Form too large");
        const form = new URLSearchParams(body);
        const query = (form.get("q") ?? "").trim();
        const terms = parseQuery(query);
        const target = new URL("/", url);
        for (const name of ["q", "cwd", "device"]) {
          const value = name === "q" ? query : form.get(name);
          if (value) target.searchParams.set(name, value);
        }
        if (terms.length) await saveSearch(env.DB, email, query);
        return new Response(null, {
          status: 303,
          headers: { ...headers, Location: target.pathname + target.search },
        });
      }
      if (request.method === "POST" && url.pathname === "/history/clear") {
        await clearSearches(env.DB, email);
        return new Response(null, {
          status: 303,
          headers: { ...headers, Location: "/" },
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/sync")
        return json(await update(env.DB, await readUpdate(request)));
      const device = url.pathname.match(
        /^\/api\/v1\/devices\/([a-zA-Z0-9_.-]{1,128})$/,
      )?.[1];
      if (request.method === "DELETE" && device) {
        const result = await env.DB.prepare(
          "DELETE FROM sessions WHERE device=?",
        )
          .bind(device)
          .run();
        return json({ deleted: result.meta.changes });
      }
      const match = url.pathname.match(
        /^\/api\/v1\/sessions\/([a-zA-Z0-9_.-]{1,128})\/(codex|claude)\/([a-zA-Z0-9_.-]{1,128})$/,
      );
      if (request.method === "DELETE" && match) {
        const result = await env.DB.prepare(
          "DELETE FROM sessions WHERE device=? AND source=? AND source_id=?",
        )
          .bind(...match.slice(1))
          .run();
        return json({ deleted: result.meta.changes });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HTTPError)
        return json({ error: error.message }, error.status);
      // Do not log SQL parameters, message bodies, or authentication tokens.
      console.error("Request failed");
      return json({ error: "Internal server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
