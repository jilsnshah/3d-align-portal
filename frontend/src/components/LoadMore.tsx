/* Paging control for the long lists.

   One extra row is fetched beyond the page size purely to answer "is there
   more?" — cheaper than a second count query, and it means the button only
   appears when pressing it would actually do something. */

import type { UseInfiniteQueryResult } from "@tanstack/react-query";

export function LoadMore({
  query,
  noun,
  shown,
}: {
  query: Pick<
    UseInfiniteQueryResult<unknown, Error>,
    "hasNextPage" | "isFetchingNextPage" | "fetchNextPage"
  >;
  noun: string;
  shown: number;
}) {
  if (!query.hasNextPage) {
    return shown > 0 ? (
      <p className="dim" style={{ textAlign: "center", padding: "10px 0" }}>
        All {shown} {noun} shown.
      </p>
    ) : null;
  }
  return (
    <div style={{ textAlign: "center", padding: "12px 0" }}>
      <button
        type="button"
        className="btn-ghost"
        disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        {query.isFetchingNextPage ? "Loading…" : `Load more ${noun}`}
      </button>
      <p className="dim" style={{ marginTop: 6 }}>
        {shown} shown so far
      </p>
    </div>
  );
}
