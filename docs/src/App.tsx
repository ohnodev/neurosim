import { useEffect, useMemo, useState } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import MenuModal from "./components/MenuModal";
import Topbar from "./components/Topbar";
import { DOCS_HOST_LABEL, getNavSubLinks, normalizePath } from "./lib/docs";
import PlatformPage from "./pages/PlatformPage";
import type { Route } from "./types/docs";

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("");
  const [docActionsOpen, setDocActionsOpen] = useState(false);
  const [docCopied, setDocCopied] = useState(false);
  const currentRoute = useMemo<Route>(() => normalizePath(window.location.pathname), []);
  const navSubLinks = useMemo(() => getNavSubLinks(currentRoute), [currentRoute]);

  const pageMarkdown = useMemo(() => {
    return ["# NeuroSim Docs", "", ...navSubLinks.map((item) => `- ${item.label}`)].join("\n");
  }, [navSubLinks]);

  useEffect(() => {
    const saved = localStorage.getItem("neurosim-docs-theme");
    const nextTheme = saved === "light" || saved === "dark" ? saved : "dark";
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("neurosim-docs-theme", theme);
  }, [theme]);

  useEffect(() => {
    Prism.highlightAll();
  }, [currentRoute]);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".section[id]"));
    if (!nodes.length) {
      setActiveSection("");
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            void setActiveSection(entry.target.id);
          }
        });
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: 0 }
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [currentRoute]);

  useEffect(() => {
    const onWindowClick = () => setDocActionsOpen(false);
    window.addEventListener("click", onWindowClick);
    return () => window.removeEventListener("click", onWindowClick);
  }, []);

  function activeSectionText() {
    const selected =
      (activeSection ? document.getElementById(activeSection) : null) ??
      document.querySelector<HTMLElement>(".section[id]");
    return selected?.innerText.trim() ?? "";
  }

  async function flashDocCopied(text: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setDocCopied(true);
      setTimeout(() => setDocCopied(false), 1200);
    } catch (error) {
      console.error("[docs] failed to copy page content", error);
    }
  }

  function openAssistant(url: string) {
    const prompt = encodeURIComponent(pageMarkdown);
    window.open(`${url}${prompt}`, "_blank", "noopener,noreferrer");
  }

  const pageActions = {
    isOpen: docActionsOpen,
    isCopied: docCopied,
    onToggle: () => setDocActionsOpen((current) => !current),
    onClose: () => setDocActionsOpen(false),
    onCopyPage: () => {
      void flashDocCopied(activeSectionText());
    },
    onCopyMarkdown: () => {
      void flashDocCopied(pageMarkdown);
    },
    onOpenClaude: () => openAssistant("https://claude.ai/new?q="),
    onOpenChatgpt: () => openAssistant("https://chatgpt.com/?q=")
  };

  return (
    <>
      <Topbar
        onOpenMenu={() => setMenuOpen(true)}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        siteLabel={DOCS_HOST_LABEL}
      />

      <MenuModal isOpen={menuOpen} activeSection={activeSection} navSubLinks={navSubLinks} onClose={() => setMenuOpen(false)} />

      <main className="main">
        <PlatformPage {...pageActions} />
      </main>
    </>
  );
}
