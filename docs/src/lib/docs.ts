import type { NavLink, Route } from "../types/docs";

export const DOCS_HOST_LABEL = "docs.neurosim.fun";

export function normalizePath(_pathname: string): Route {
  return "/";
}

export function getNavSubLinks(_route: Route): NavLink[] {
  return [
    { id: "introduction", label: "Introduction" },
    { id: "how-it-works", label: "How It Works" },
    { id: "connectome", label: "The Connectome" },
    { id: "lore", label: "Lore" },
    { id: "pricing", label: "Pricing" }
  ];
}
