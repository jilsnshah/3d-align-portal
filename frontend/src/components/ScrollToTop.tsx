import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Open a page at its beginning.
 *
 *  A browser keeps the scroll position when the address changes under a single
 *  page app, so opening the fortieth row of the case list dropped the reader
 *  two thousand pixels down the case that row opened — under the tabs, past
 *  the one thing the case was asking them to do.
 *
 *  Only the path resets the view. The portal keeps which tab, filter or panel
 *  is open in the query string, and those change without the page changing —
 *  scrolling to the top on those would yank the page away mid-task.
 */
export default function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname]);

  return null;
}
