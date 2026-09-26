const checkbox = document.getElementById("markdown");
checkbox.addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.set("markdown", checkbox.checked ? "1" : "0");
  location.assign(url);
});
