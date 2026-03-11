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

  const pageMarkdown = useMemo(
    () =>
      [
        "# NeuroSim Docs",
        "",
        "NeuroSim is a fly-brain simulation where you buy NeuroFlies, release them into the world, and earn $NEURO when they collect food. It uses a real *Drosophila* fruit fly connectome (FlyWire).",
        "",
        "## Introduction",
        "",
        "- **Real Connectome**: FlyWire dataset — real neurons and connections from *Drosophila melanogaster*.",
        "- **Autonomous Behavior**: Flies navigate, get hungry, seek food, rest, and explore.",
        "- **Token Rewards**: Each food item collected rewards ~1,000 $NEURO tokens.",
        "- **3D World**: Watch your NeuroFlies at world.neurosim.fun.",
        "",
        "## How It Works",
        "",
        "1. Buy a NeuroFly for 1,000,000 $NEURO tokens.",
        "2. Release it into the simulation (Enter World).",
        "3. The fly autonomously navigates — seeks food, rests, explores.",
        "4. Each food collected rewards approximately 1,000 $NEURO.",
        "",
        "## The Connectome",
        "",
        "Uses the FlyWire dataset — real neurons and synapses from *Drosophila melanogaster*. Neurons drive hunger, exploration, rest, and movement. A toy neural simulation steps the connectome forward in time.",
        "",
        "## Lore",
        "",
        "Inspired by [The First Multi-Behavior Brain Upload](https://theinnermostloop.substack.com/p/the-first-multi-behavior-brain-upload).",
        "",
        "## Pricing",
        "",
        "1 NeuroFly = 1,000,000 $NEURO. Each food = ~1,000 $NEURO."
      ].join("\n"),
    []
  );

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
    nodes.forEach((node) => {
      observer.observe(node);
    });
    return () => observer.disconnect();
  }, [currentRoute]);

  useEffect(() => {
    const onWindowClick = () => setDocActionsOpen(false);
    window.addEventListener("click", onWindowClick);
    return () => window.removeEventListener("click", onWindowClick);
  }, []);

  function getFullPageText() {
    return document.querySelector<HTMLElement>(".main .content")?.innerText?.trim() ?? "";
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
      void flashDocCopied(getFullPageText());
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
