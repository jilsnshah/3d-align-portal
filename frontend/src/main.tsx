/* Inter, self-hosted and variable. The stylesheet asked for it and never
   loaded it, so every screen fell through to whatever the operating system
   supplies — SF on a Mac, Segoe on Windows — and the type was different for
   every person looking at it. The optical-size axis is what keeps small text
   legible and large text tight without hand-tuning tracking at each size. */
import "@fontsource-variable/inter/opsz.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { sessionSlot } from "./api";
import { AuthProvider } from "./auth";
import "./styles.css";

// Claim this tab's session slot before the first request goes out.
sessionSlot();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
