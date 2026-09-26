export async function recentSearches(db: D1Database, email: string) {
  const { results } = await db
    .prepare(
      "SELECT query FROM search_history WHERE email=? ORDER BY id DESC LIMIT 20",
    )
    .bind(email)
    .all<{ query: string }>();
  return results.map((row) => row.query);
}

export async function saveSearch(db: D1Database, email: string, query: string) {
  // Replacement allocates a new ID, moving repeated queries to the front.
  await db.batch([
    db
      .prepare(
        "INSERT OR REPLACE INTO search_history(email, query) VALUES (?, ?)",
      )
      .bind(email, query),
    db
      .prepare(
        `DELETE FROM search_history WHERE email=? AND id NOT IN (
      SELECT id FROM search_history WHERE email=? ORDER BY id DESC LIMIT 20
    )`,
      )
      .bind(email, email),
  ]);
}

export async function clearSearches(db: D1Database, email: string) {
  await db
    .prepare("DELETE FROM search_history WHERE email=?")
    .bind(email)
    .run();
}
