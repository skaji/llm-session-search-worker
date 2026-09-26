import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

for (const source of document.querySelectorAll("#messages .message-source")) {
  const formatted = document.createElement("div");
  formatted.className = "markdown";
  // Only the safe renderer's output becomes HTML; conversation HTML stays literal.
  formatted.innerHTML = micromark(source.textContent, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml({ clobberPrefix: `${source.parentElement.id}-` })],
  });
  // GFM prefixes footnote IDs but uses a fixed ID for each section's label.
  const label = formatted.querySelector("#footnote-label");
  if (label) {
    label.id = `${source.parentElement.id}-footnote-label`;
    for (const reference of formatted.querySelectorAll("[data-footnote-ref]")) {
      reference.setAttribute("aria-describedby", label.id);
    }
  }
  for (const table of formatted.querySelectorAll("table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "Table (scroll horizontally)");
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  source.replaceWith(formatted);
}

// Formatting can move a search result's anchor after the initial browser scroll.
if (location.hash) {
  document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
