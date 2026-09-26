import type { Hit, Session } from "./types";
export const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const jst = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function timestamp(ms: number) {
  if (ms === 0) return "Unknown update time";
  const date = new Date(ms);
  const parts = Object.fromEntries(
    jst.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `<time datetime="${date.toISOString()}">${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST</time>`;
}
const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "always" });
function relativeTimestamp(ms: number, now: number) {
  if (ms === 0) return "Unknown update time";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  let label = "just now";
  const units = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ] as const;
  for (const [unit, duration] of units) {
    if (seconds >= duration) {
      label = relativeTime.format(-Math.floor(seconds / duration), unit);
      break;
    }
  }
  return `<time datetime="${new Date(ms).toISOString()}">${label}</time>`;
}
function deviceStyle(device: string) {
  return device === "imac2024"
    ? "imac"
    : device === "MBA2023"
      ? "mba"
      : "other";
}
function deviceBadge(device: string) {
  const style = deviceStyle(device);
  const icon =
    style === "imac"
      ? '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M12 16v5m-5 0h10"/>'
      : style === "mba"
        ? '<path d="M5 16V5h14v11M2 16h20l-2 4H4z"/>'
        : '<rect x="5" y="3" width="14" height="18" rx="2"/>';
  return `<span class="device-badge device-${style}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">${icon}</svg>${escape(device)}</span>`;
}
function page(body: string, email: string, layout = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Session Search</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>
  :root{font-family:system-ui,sans-serif;color:#202938;background:#fff;color-scheme:light}
  *{box-sizing:border-box}body{max-width:1028px;margin:0 auto;padding:24px}
  header{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:24px}
  h1{font-size:24px;margin:0}h1 a{color:#172d49;text-decoration:none}a{color:#2056ab}
  .account{font-size:14px;overflow-wrap:anywhere}.account small{display:block;color:#657085}
  .search-page{max-width:1300px}
  .search-layout{display:grid;grid-template-columns:260px minmax(0,1fr);grid-template-rows:auto 1fr;grid-template-areas:"history form" "history results";gap:0 28px;align-items:start}
  .search-layout>.search-form{grid-area:form;margin-top:0}.search-results{grid-area:results;min-width:0}
  .search-layout>.history{grid-area:history;min-width:0;margin:0;padding:16px;background:white;border:1px solid #dde3eb;border-radius:10px;position:sticky;top:24px;max-height:calc(100vh - 48px);overflow:auto}
  .search-layout>.history ul{display:grid}.search-layout>.history li button{width:100%}.history-heading{flex-wrap:wrap}
  .search-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;margin:24px 0 12px}
  label{display:grid;gap:6px;font-size:13px;min-width:0}input,button{font:inherit;font-size:16px;padding:10px 12px;border:1px solid #bec9d8;border-radius:8px;min-height:44px;min-width:0;width:100%}
  input{background:white;color:#202938}button{background:white;color:#202938;cursor:pointer;align-self:end}
  .history{margin:16px 0}.history-heading{display:flex;align-items:center;gap:16px;justify-content:space-between}.history-heading h2{font-size:14px;margin:0;color:#59667a}
  .history form{margin:0}.history ul{display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:8px 0;list-style:none}.history li{max-width:100%}
  .history button{background:white;color:#2056ab;width:auto;text-align:left;overflow-wrap:anywhere;font-size:14px}.history-heading button{border:0;background:transparent;font-size:13px;white-space:nowrap}
  .device-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:16px 0}
  .device-filters a{display:inline-flex;align-items:center;min-height:44px;padding:4px 10px;border:1px solid #c7d1df;border-radius:9px;text-decoration:none;background:white;font-size:14px}
  .device-filters a[aria-current="true"]{outline:2px solid #172d49;outline-offset:1px}
  article{padding:14px 0;margin:0;border-top:1px solid #dde3eb}
  h2{font-size:18px;line-height:1.45;margin:0 0 10px;overflow-wrap:anywhere}
  .meta{font-size:13px;color:#59667a;overflow-wrap:anywhere;line-height:1.6}.session-meta{display:flex;gap:8px 12px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
  .device-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:6px;background:#edf0f4;color:#425069;font-size:13px;white-space:nowrap}
  .device-badge.device-imac{background:#ffedd5;color:#9a3412}.device-badge.device-mba{background:#fef9c3;color:#854d0e}.device-badge svg{width:18px;height:18px;flex-shrink:0}
  .message{border:0;padding:0;margin:28px 0;min-width:0}
  .message-user{width:fit-content;max-width:85%;margin-left:auto;padding:18px 22px;border-radius:20px;background:#e8f3ff}
  .message-source{margin:0}.message:target{outline:2px solid #689bed;outline-offset:6px}
  .message-controls{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:20px 0}
  .message-controls a{display:inline-flex;align-items:center;min-height:44px}
  .markdown{font-size:14px;line-height:1.75;overflow-wrap:anywhere;min-width:0}
  .markdown>:first-child{margin-top:0}.markdown>:last-child{margin-bottom:0}
  .markdown :is(h1,h2,h3,h4,h5,h6){margin:24px 0 10px;line-height:1.45}.markdown h1{font-size:21px}.markdown h2{font-size:19px}.markdown h3{font-size:17px}
  .markdown p,.markdown :is(ul,ol){margin:12px 0}.markdown :is(ul,ol){padding-left:25px}
  .markdown code{padding:2px 5px;border-radius:4px;background:#f0f2f5;font:0.92em/1.6 ui-monospace,monospace}
  .markdown pre{max-width:100%;padding:14px;overflow-x:auto;white-space:pre;overflow-wrap:normal;background:#f6f7f9;border:1px solid #e6e9ee;border-radius:6px}
  .markdown pre code{padding:0;background:none}.markdown blockquote{margin:14px 0;padding:1px 16px;border-left:3px solid #cbd5e1;color:#59667a}
  .markdown .table-scroll{max-width:100%;overflow-x:auto;margin:14px 0}.markdown table{border-collapse:collapse;min-width:100%;width:max-content}
  .markdown :is(th,td){min-width:100px;max-width:340px;padding:8px 12px;border:1px solid #dde3eb;text-align:left;vertical-align:top}.markdown th{background:#f6f7f9}
  .markdown [align="center"]{text-align:center}.markdown [align="right"]{text-align:right}.markdown img{max-width:100%;height:auto}
  @media(max-width:700px){.message-user{max-width:95%;padding:14px 16px;border-radius:16px}}

  time{white-space:nowrap;font-variant-numeric:tabular-nums}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 ui-monospace,monospace;margin-bottom:0}.excerpt{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;margin-bottom:0}
  .search-results .session-meta{margin-bottom:6px}.search-results h2{margin-bottom:6px}.search-results h2 a{text-decoration:none}.search-results .excerpt{margin-top:6px}
  nav{margin:24px 0}nav a,.read-start{display:inline-flex;align-items:center;min-height:44px}article:target{border-color:#2056ab}
  button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #689bed;outline-offset:3px}
  @media(max-width:900px){.search-layout{grid-template-columns:minmax(0,1fr);grid-template-areas:"form" "history" "results"}.search-layout>.history{position:static;max-height:none;padding:0;border:0;background:transparent;margin:16px 0}.search-layout>.history ul{display:flex}.search-layout>.history.history-empty{display:none}}
  @media(max-width:700px){body{padding:16px}.search-layout{grid-template-areas:"form" "results"}.search-layout>.history{display:none}.session-meta{gap:8px}h1{font-size:22px}.device-filters{gap:6px}.device-filters a{padding:4px 6px;font-size:13px}.device-filters .device-badge{padding:4px 5px;font-size:12px}}
  @media(max-width:340px){body{padding:12px}.account{font-size:13px}}

  </style></head><body class="${layout}"><header><h1><a href="/">LLM Session Search</a></h1><div class="account"><small>${escape(email)}</small><a href="/cdn-cgi/access/logout">Log out</a></div></header>${body}</body></html>`;
}
export function searchPage(
  url: URL,
  result: { results: Hit[]; next_offset: number | null },
  email: string,
  history: string[] = [],
) {
  const now = Date.now();
  const next = new URL(url);
  if (result.next_offset !== null)
    next.searchParams.set("offset", String(result.next_offset));
  const selectedDevice = url.searchParams.get("device") ?? "";
  const filters = ["", "imac2024", "MBA2023"]
    .map((device) => {
      const link = new URL(url);
      link.searchParams.delete("offset");
      if (device) link.searchParams.set("device", device);
      else link.searchParams.delete("device");
      return `<a href="${escape(link.pathname + link.search)}" ${selectedDevice === device ? 'aria-current="true"' : ""}>${device ? deviceBadge(device) : "All devices"}</a>`;
    })
    .join("");
  return page(
    `<div class="search-layout"><form class="search-form" action="/search" method="post"><input name="q" aria-label="Search" value="${escape(url.searchParams.get("q") ?? "")}"><input type="hidden" name="device" value="${escape(selectedDevice)}"><button>Search</button></form>
  ${history.length ? `<aside class="history" aria-label="Recent searches"><div class="history-heading"><h2>Recent searches</h2><form action="/history/clear" method="post"><button>Clear history</button></form></div><ul>${history.map((query) => `<li><form action="/search" method="post"><button name="q" value="${escape(query)}">${escape(query)}</button></form></li>`).join("")}</ul></aside>` : `<aside class="history history-empty" aria-label="Recent searches"><div class="history-heading"><h2>Recent searches</h2></div><p class="meta">Your searches will appear here.</p></aside>`}
  <main class="search-results"><nav class="device-filters" aria-label="Filter by device">${filters}</nav>
  ${result.results.map((s) => `<article><div class="session-meta">${deviceBadge(s.device)}<span class="meta">${escape(s.source)}${s.archived ? " · archived" : ""}</span><span class="meta">${relativeTimestamp(s.updated_at_ms, now)}</span></div><h2><a href="/sessions/${s.id}?after=${Math.max(0, s.line - 1)}#line-${s.line}">${escape(s.title || s.source_id)}</a></h2><p class="excerpt">${escape(s.snippet)}</p></article>`).join("") || "<p>No sessions found.</p>"}
  ${result.next_offset !== null ? `<nav><a href="${escape(next.pathname + next.search)}">Next page →</a></nav>` : ""}</main></div>`,
    email,
    "search-page",
  );
}
export function detailPage(
  result: {
    session: Session;
    records: { line: number; role: string; text: string }[];
    next_after: number | null;
  },
  email: string,
  url = new URL(`https://localhost/sessions/${result.session.id}`),
) {
  const s = result.session;
  const markdown = url.searchParams.get("markdown") === "1";
  const toggle = new URL(url);
  toggle.searchParams.set("markdown", markdown ? "0" : "1");
  const start = new URL(url);
  start.searchParams.delete("after");
  start.hash = "";
  const next = new URL(url);
  next.searchParams.set("after", String(result.next_after));
  next.hash = "";
  const href = (link: URL) => escape(link.pathname + link.search + link.hash);
  return page(
    `<div class="session-meta">${deviceBadge(s.device)}<span class="meta">${escape(s.source)}${s.archived ? " · archived" : ""}</span><span class="meta">${timestamp(s.updated_at_ms)}</span></div><h2>${escape(s.title || s.source_id)}</h2><p class="meta">${escape(s.cwd)}<br>${escape(s.path)}</p><div class="message-controls"><a href="${href(start)}">Read from the beginning</a><a href="${href(toggle)}">Markdown: ${markdown ? "on" : "off"}</a></div>
  <main id="messages">${result.records.map((r) => `<article id="line-${r.line}" class="message${r.role === "user" ? " message-user" : ""}" aria-label="${escape(r.role)} message"><pre class="message-source">${escape(r.text)}</pre></article>`).join("") || "<p>No messages on this page.</p>"}</main>
  ${result.next_after !== null ? `<nav><a href="${href(next)}">Next messages →</a></nav>` : ""}
  ${markdown ? '<script src="/assets/markdown.js" defer></script>' : ""}`,
    email,
  );
}
