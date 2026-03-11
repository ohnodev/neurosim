import { useState } from "react";
import type { CodeTab } from "../types/docs";

type CodeBlockTabsProps = {
  tabs: CodeTab[];
};

export default function CodeBlockTabs({ tabs }: CodeBlockTabsProps) {
  const [activeTab, setActiveTab] = useState(tabs[0]?.key ?? "");
  const activePanel = tabs.find((tab) => tab.key === activeTab) ?? tabs[0];
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    if (!activePanel) return;
    try {
      await navigator.clipboard.writeText(activePanel.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 900);
    } catch (error) {
      console.warn("[docs] failed to copy code snippet", error);
    }
  }

  return (
    <div className="code-block code-tabs" data-tabs>
      <div className="code-head">
        <div className="code-tabs__nav">
          {tabs.map((tab) => (
            <button key={tab.key} className={`code-tab ${activeTab === tab.key ? "is-active" : ""}`} onClick={() => setActiveTab(tab.key)}>
              {tab.iconSrc ? <img className="code-tab__icon" src={tab.iconSrc} alt={tab.iconAlt ?? ""} /> : null}
              {tab.iconOnly ? <span className="sr-only">{tab.label}</span> : <span>{tab.label}</span>}
            </button>
          ))}
        </div>
        <button className={`copy-code ${copied ? "copy-success" : ""}`} onClick={onCopy} aria-label={copied ? "Copied" : "Copy code"}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M8 8.75C8 7.50736 9.00736 6.5 10.25 6.5H17.75C18.9926 6.5 20 7.50736 20 8.75V16.25C20 17.4926 18.9926 18.5 17.75 18.5H10.25C9.00736 18.5 8 17.4926 8 16.25V8.75Z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M4 14.75V7.25C4 6.00736 5.00736 5 6.25 5H13.75"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span className="sr-only">{copied ? "Copied" : "Copy code"}</span>
        </button>
      </div>

      {tabs.map((tab) => (
        <div key={tab.key} className={`code-tab-panel ${activeTab === tab.key ? "is-active" : ""}`}>
          <pre>
            <code className={`language-${tab.language}`}>{tab.content}</code>
          </pre>
        </div>
      ))}
    </div>
  );
}
