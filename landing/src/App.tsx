import { useState } from 'react';
import { OnchainProviders } from './components/OnchainProviders';
import { BrainPlot } from './components/BrainPlot';
import { MyNeuroFlies } from './components/MyNeuroFlies';
import { ConnectButton } from './components/ConnectButton';
import './App.css';

const LORE_ARTICLE = 'https://theinnermostloop.substack.com/p/the-first-multi-behavior-brain-upload';
const X_URL = 'https://x.com/i/communities/2031850986466078872';
const TG_URL = 'https://t.me/neurosimportal';

/** Token address - single config to update later. */
const TOKEN_ADDRESS = '0x73e0591f7b75cc4D82B415d34Cd353683C896cbf';

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DocsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function ArticleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="8" y1="11" x2="16" y2="11" />
      <line x1="8" y1="15" x2="12" y2="15" />
    </svg>
  );
}

function WorldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function App() {
  const [caCopied, setCaCopied] = useState(false);

  const handleCopyCA = async () => {
    try {
      await navigator.clipboard.writeText(TOKEN_ADDRESS);
      setCaCopied(true);
      setTimeout(() => setCaCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  return (
    <OnchainProviders>
      <div className="app">
        <div className="bg" aria-hidden />
        <header className="header">
          <span className="header__ticker">$NEURO</span>
          <div className="header__actions">
            <ConnectButton />
          </div>
        </header>

        <div className="dashboard">
          <section className="dashboard__hero">
            <div className="hero__brain">
              <BrainPlot />
            </div>
            <div className="hero__neuroflies">
              <MyNeuroFlies />
            </div>
            <div className="hero__text">
              <h1 className="hero__title">NeuroSim</h1>
              <p className="hero__tagline">
                Release NeuroFlies into the simulation to compete for resources and earn tokens. We load real fruit fly neurons and connections, feed them sensory data, and execute actions from the model — navigating your fly in the world.
              </p>
            </div>
          </section>

          <aside className="dashboard__sidebar">
            <div className="card card--intro">
              <h2 className="card__title">About</h2>
              <p className="card__text">
                Token launched on{' '}
                <a href={`https://thecabal.app/base/${TOKEN_ADDRESS}`} target="_blank" rel="noopener noreferrer" className="card__link-inline">The Cabal</a>
                . Heard about the first multi-behavior brain upload, went down the rabbit hole, got the dataset, added the interface, wrapped crypto around it, and shipped it — Cabal style.
              </p>
            </div>

            <div className="card card--links">
              <h2 className="card__title">Links</h2>
              <a href="https://docs.neurosim.fun" target="_blank" rel="noopener noreferrer" className="card__link-btn">
                <DocsIcon />
                <span>Docs</span>
              </a>
              <a href={LORE_ARTICLE} target="_blank" rel="noopener noreferrer" className="card__link-btn">
                <ArticleIcon />
                <span>Lore · First Multi-Behavior Brain Upload</span>
              </a>
              <a href="https://world.neurosim.fun" target="_blank" rel="noopener noreferrer" className="card__link-btn">
                <WorldIcon />
                <span>Enter World</span>
              </a>
            </div>

            <div className="card card--socials">
              <h2 className="card__title">Socials</h2>
              <div className="socials">
                <a href={X_URL} target="_blank" rel="noopener noreferrer" className="card__link">
                  X
                </a>
                <a href={TG_URL} target="_blank" rel="noopener noreferrer" className="card__link">
                  Telegram
                </a>
              </div>
              <div className="socials__ca">
                <button
                  type="button"
                  className="ca-copy"
                  onClick={handleCopyCA}
                  aria-label="Copy contract address"
                >
                  <code className="ca-copy__value">{formatAddress(TOKEN_ADDRESS)}</code>
                  <span className="ca-copy__icon">{caCopied ? <CheckIcon /> : <CopyIcon />}</span>
                </button>
                <a
                  href={`https://basescan.org/address/${TOKEN_ADDRESS}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ca-basescan"
                  title="View on BaseScan"
                  aria-label="View contract on BaseScan"
                >
                  <img src="/basescan-logo.svg" alt="" width={20} height={20} />
                </a>
              </div>
            </div>

          </aside>
        </div>

        <section className="youtube-section">
          <div className="youtube-section-inner">
            <h2 className="youtube-section-title">See NeuroSim in action</h2>
            <p className="youtube-section-desc">
              Watch how we load fruit fly neurons, feed them sensory data, and run the simulation.
            </p>
            <div className="youtube-embed-wrap">
              <iframe
                src="https://www.youtube-nocookie.com/embed/tV874dr02yQ"
                title="NeuroSim project overview"
                loading="lazy"
                referrerPolicy="no-referrer"
                allow="encrypted-media; picture-in-picture"
                allowFullScreen
                className="youtube-embed"
              />
            </div>
          </div>
        </section>

        <footer className="footer">
          <div className="footer__brand">
            <a
              href="https://thecabal.app"
              target="_blank"
              rel="noopener noreferrer"
              className="footer__cabal-link"
              title="The Cabal"
            >
              <img
                src="/cabal-king-512-opt.jpg"
                alt="The Cabal"
                className="footer__cabal-logo"
              />
            </a>
            <div className="footer__text">
              <span className="footer__copy">NeuroSim — $NEURO. Launched on the Cabal.</span>
              <span className="footer__obelisk">
                Powered by{' '}
                <a href="https://theobelisk.ai" target="_blank" rel="noopener noreferrer">
                  theobelisk.ai
                </a>
                — part of The Obelisk initiative into AI consciousness.
              </span>
            </div>
          </div>
        </footer>
      </div>
    </OnchainProviders>
  );
}

export default App;
