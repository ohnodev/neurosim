export type DocActionsProps = {
  isOpen: boolean;
  isCopied: boolean;
  onToggle: () => void;
  onClose: () => void;
  onCopyPage: () => void;
  onCopyMarkdown: () => void;
  onOpenClaude: () => void;
  onOpenChatgpt: () => void;
};

export default function DocActions({
  isOpen,
  isCopied,
  onToggle,
  onClose,
  onCopyPage,
  onCopyMarkdown,
  onOpenClaude,
  onOpenChatgpt
}: DocActionsProps) {
  return (
    <div className={`doc-actions doc-actions--inline ${isOpen ? "open" : ""} ${isCopied ? "copied" : ""}`}>
      <button
        className="doc-actions__toggle"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span className="doc-actions__label">{isCopied ? "Copied!" : "Copy page"}</span>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>

      {!isOpen ? null : (
        <div className="doc-actions__menu" role="menu" onClick={(event) => event.stopPropagation()}>
          <button
            className="doc-action-item"
            role="menuitem"
            onClick={() => {
              onCopyPage();
              onClose();
            }}
          >
            Copy page
          </button>
          <button
            className="doc-action-item"
            role="menuitem"
            onClick={() => {
              onCopyMarkdown();
              onClose();
            }}
          >
            Copy page as Markdown for LLMs
          </button>
          <button
            className="doc-action-item"
            role="menuitem"
            onClick={() => {
              onOpenClaude();
              onClose();
            }}
          >
            Open in Claude
          </button>
          <button
            className="doc-action-item"
            role="menuitem"
            onClick={() => {
              onOpenChatgpt();
              onClose();
            }}
          >
            Open in ChatGPT
          </button>
        </div>
      )}
    </div>
  );
}
